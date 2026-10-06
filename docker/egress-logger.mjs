/**
 * Transparent egress logger (passive, log-only — never gates).
 *
 * Runs in a sidecar that shares the agent container's network namespace, so it
 * sees all of the agent's outbound traffic. It sniffs with tcpdump — it is NOT
 * in the data path, so it adds no latency to scans. It records, per day, the
 * first time the agent:
 *   - makes a DNS lookup for a hostname  → {event:"egress.dns", host}
 *   - opens a TCP connection to an IP:port → {event:"egress.connect", dst, port}
 * to /workspace/logs/egress-<date>.jsonl.
 *
 * Deduped to "distinct destinations" so a scan of thousands of requests doesn't
 * bury the log. Hostnames come from DNS; direct-IP targets (e.g. `nmap 1.2.3.4`)
 * are captured as connect events. Correlate IPs↔hostnames with the command
 * audit log (which records the full tool command) by timestamp.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const LOG_DIR = process.env.OPEN_RUNNER_LOG_DIR ?? "/workspace/logs";
// Hosts that are infrastructure, not scan targets — tagged so they're easy to filter out.
const INFRA = new Set(["runner", "127.0.0.1", "::1"]);

fs.mkdirSync(LOG_DIR, { recursive: true });
const seenConnect = new Set();
const seenDns = new Set();

function write(rec) {
  const now = new Date();
  const line = JSON.stringify({ ts: now.toISOString(), ...rec }) + "\n";
  fs.appendFile(path.join(LOG_DIR, `egress-${now.toISOString().slice(0, 10)}.jsonl`), line, (e) => {
    if (e) console.error("[egress-logger] write failed:", e.message);
  });
}

// Outbound SYN (new TCP connection) or any DNS query.
const filter = "(tcp[tcpflags] & tcp-syn != 0 and tcp[tcpflags] & tcp-ack == 0) or (udp port 53)";
// Starts as root (CAP_NET_RAW) to open the capture socket, then tcpdump drops to
// its own unprivileged `tcpdump` user (needs CAP_SETUID/SETGID, granted in compose).
const tcpdump = spawn("tcpdump", ["-i", "any", "-nn", "-l", "-tttt", filter], { stdio: ["ignore", "pipe", "inherit"] });

let buf = "";
tcpdump.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    handle(line);
  }
});
tcpdump.on("exit", (code) => {
  console.error(`[egress-logger] tcpdump exited (${code})`);
  process.exit(code ?? 1);
});

function handle(line) {
  // DNS query: "... > x.x.x.x.53: 1234+ A? host.example.com. (33)"
  const dns = line.match(/\s(?:A|AAAA|CNAME)\?\s+([A-Za-z0-9._-]+?)\.?\s+\(/);
  if (dns) {
    const host = dns[1].toLowerCase();
    if (host && !seenDns.has(host)) {
      seenDns.add(host);
      write({ event: "egress.dns", host });
    }
    return;
  }
  // Outbound TCP SYN (not SYN-ACK): "... > 45.33.32.156.443: Flags [S], ..."
  if (line.includes("Flags [S],")) {
    const m = line.match(/>\s+(\d{1,3}(?:\.\d{1,3}){3})\.(\d+):\s+Flags \[S\],/) // IPv4
           || line.match(/>\s+([0-9a-f:]+)\.(\d+):\s+Flags \[S\],/);            // IPv6
    if (!m) return;
    const dst = m[1];
    const port = Number(m[2]);
    const key = `${dst}:${port}`;
    if (!seenConnect.has(key)) {
      seenConnect.add(key);
      write({ event: "egress.connect", dst, port, infra: INFRA.has(dst) || undefined });
    }
  }
}

process.on("SIGTERM", () => { tcpdump.kill("SIGTERM"); process.exit(0); });
process.on("SIGINT", () => { tcpdump.kill("SIGINT"); process.exit(0); });
console.error(`[egress-logger] watching agent egress -> ${LOG_DIR}/egress-<date>.jsonl`);
