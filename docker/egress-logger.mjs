/**
 * Egress sidecar for the agent container. Two jobs:
 *
 *   1. LOG (always). Shares the agent's network namespace and sniffs its
 *      outbound traffic with tcpdump — not in the data path, so it adds no
 *      latency to scans. Records, per day, the first DNS lookup for a host and
 *      the first TCP connection to an IP:port, to /logs/egress-<date>.jsonl.
 *
 *   2. ENFORCE (opt-in). When the mode is "enforce", installs a deny-by-default
 *      `BXH_EGRESS` chain in that shared namespace (iptables + ip6tables):
 *      loopback, established flows and DNS are allowed, plus each allow-listed
 *      destination (the in-scope target and any operator "also allow" host);
 *      everything else is REJECTed and rate-logged. Default is "monitor"
 *      (log-only) — you never lose the audit trail by staying there.
 *
 * Privilege separation: only this sidecar holds CAP_NET_ADMIN, so the agent
 * (which shares the namespace but not the capability) cannot alter the rules.
 *
 * The mode + allow list come from EGRESS_MODE / EGRESS_ALLOW, overridable at
 * runtime by a JSON policy file (EGRESS_POLICY_FILE, default
 * /logs/egress-policy.json) that the runner can write per engagement — the
 * sidecar re-reads it every cycle, so the toggle flips without a restart.
 */
import { spawn } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  readPolicy, buildChainRules, ipAllowed, isV6, EGRESS_CHAIN,
} from "./egress-filter.mjs";

const LOG_DIR = process.env.OPEN_RUNNER_LOG_DIR ?? "/workspace/logs";
const POLICY_FILE = process.env.EGRESS_POLICY_FILE ?? path.join(LOG_DIR, "egress-policy.json");
const RECONCILE_MS = Math.max(5000, Number(process.env.EGRESS_RECONCILE_MS) || 30000);
// Infra the agent must always reach under enforce: the runner (model proxy) and
// any extra operator-named hosts. Resolved and allowed independent of EGRESS_ALLOW.
const INFRA_HOSTS = (process.env.EGRESS_INFRA_HOSTS ?? "runner").split(/[\s,]+/).filter(Boolean);
// Hosts tagged as infrastructure (not scan targets) in the monitor log.
const INFRA = new Set(["runner", "127.0.0.1", "::1"]);

fs.mkdirSync(LOG_DIR, { recursive: true });
const seenConnect = new Set();
const seenDns = new Set();

function write(rec) {
  const now = new Date();
  const line = JSON.stringify({ ts: now.toISOString(), ...rec }) + "\n";
  fs.appendFile(path.join(LOG_DIR, `egress-${now.toISOString().slice(0, 10)}.jsonl`), line, (e) => {
    if (e) console.error("[egress] write failed:", e.message);
  });
}

/* ─────────────────────────── passive logger ─────────────────────────── */

// The current allow set, refreshed by the reconcile loop; used only to tag the
// monitor log with whether a destination was in scope (best-effort, IPv4).
let currentAllow = { hosts: [], literals: [] };

const filter = "(tcp[tcpflags] & tcp-syn != 0 and tcp[tcpflags] & tcp-ack == 0) or (udp port 53)";
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
  console.error(`[egress] tcpdump exited (${code})`);
  process.exit(code ?? 1);
});

function handle(line) {
  const dnsm = line.match(/\s(?:A|AAAA|CNAME)\?\s+([A-Za-z0-9._-]+?)\.?\s+\(/);
  if (dnsm) {
    const host = dnsm[1].toLowerCase();
    if (host && !seenDns.has(host)) {
      seenDns.add(host);
      write({ event: "egress.dns", host });
    }
    return;
  }
  if (line.includes("Flags [S],")) {
    const m = line.match(/>\s+(\d{1,3}(?:\.\d{1,3}){3})\.(\d+):\s+Flags \[S\],/) // IPv4
           || line.match(/>\s+([0-9a-f:]+)\.(\d+):\s+Flags \[S\],/);            // IPv6
    if (!m) return;
    const dst = m[1];
    const port = Number(m[2]);
    const key = `${dst}:${port}`;
    if (!seenConnect.has(key)) {
      seenConnect.add(key);
      const rec = { event: "egress.connect", dst, port };
      if (INFRA.has(dst)) rec.infra = true;
      else if (!isV6(dst)) rec.inScope = ipAllowed(dst, currentAllow) || undefined;
      write(rec);
    }
  }
}

/* ─────────────────────────── enforcement ─────────────────────────── */

function run(bin, args) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => resolve({ code: -1, out, err: e.message }));
    p.on("exit", (code) => resolve({ code: code ?? -1, out, err }));
  });
}
const ipt = (fam, args) => run(fam === "inet6" ? "ip6tables" : "iptables", ["-w", ...args]);

async function resolveHost(host) {
  const v4 = [], v6 = [];
  const a = await dns.resolve4(host).catch(() => []);
  const aaaa = await dns.resolve6(host).catch(() => []);
  for (const ip of a) v4.push(ip);
  for (const ip of aaaa) v6.push(ip);
  return { v4, v6 };
}

// Resolve the allow list + infra hosts into per-family accept lists.
async function resolveAccepts(allow) {
  const v4 = new Set(), v6 = new Set();
  for (const l of allow.literals) (l.family === "inet6" ? v6 : v4).add(l.addr);
  for (const host of [...allow.hosts, ...INFRA_HOSTS]) {
    const r = await resolveHost(host);
    r.v4.forEach((ip) => v4.add(ip));
    r.v6.forEach((ip) => v6.add(ip));
  }
  return { v4: [...v4].sort(), v6: [...v6].sort() };
}

async function ensureFamily(fam) {
  const mk = await ipt(fam, ["-N", EGRESS_CHAIN]); // code 1 = chain exists (fine)
  if (mk.code === -1) throw new Error(`${fam} tables unavailable: ${mk.err}`); // binary missing
  const has = await ipt(fam, ["-C", "OUTPUT", "-j", EGRESS_CHAIN]);
  if (has.code !== 0) await ipt(fam, ["-I", "OUTPUT", "1", "-j", EGRESS_CHAIN]);
}

async function populateFamily(fam, accepts) {
  await ensureFamily(fam);
  await ipt(fam, ["-F", EGRESS_CHAIN]);
  for (const rule of buildChainRules(accepts, fam)) {
    const r = await ipt(fam, rule);
    if (r.code !== 0) console.error(`[egress] ${fam} rule failed:`, rule.join(" "), r.err.trim());
  }
}

async function teardownFamily(fam) {
  // Remove every OUTPUT jump, then flush and drop the chain → back to log-only.
  for (let i = 0; i < 8; i++) {
    const has = await ipt(fam, ["-C", "OUTPUT", "-j", EGRESS_CHAIN]);
    if (has.code !== 0) break;
    await ipt(fam, ["-D", "OUTPUT", "-j", EGRESS_CHAIN]);
  }
  await ipt(fam, ["-F", EGRESS_CHAIN]);
  await ipt(fam, ["-X", EGRESS_CHAIN]);
}

// Cumulative count of REJECTed (denied) packets, read from the chain's last rule.
async function readDenied(fam) {
  const r = await ipt(fam, ["-n", "-v", "-x", "-L", EGRESS_CHAIN]);
  if (r.code !== 0) return 0;
  for (const line of r.out.split("\n")) {
    if (line.includes("REJECT")) {
      const pkts = Number(line.trim().split(/\s+/)[0]);
      if (Number.isFinite(pkts)) return pkts;
    }
  }
  return 0;
}

let appliedMode = "monitor";
let appliedSig = "";
let deniedCumulative = 0;
let prevDenied = { inet: 0, inet6: 0 };
let v6Ok = true;

async function reconcile() {
  let fileText;
  try { fileText = await fsp.readFile(POLICY_FILE, "utf8"); } catch { /* no policy file */ }
  const { mode, allow } = readPolicy(process.env, fileText);
  currentAllow = allow;

  if (mode === "monitor") {
    if (appliedMode === "enforce") {
      await teardownFamily("inet");
      if (v6Ok) await teardownFamily("inet6");
      write({ event: "egress.mode", mode: "monitor" });
    }
    appliedMode = "monitor";
    appliedSig = "";
    return;
  }

  // enforce
  const accepts = await resolveAccepts(allow);
  const sig = JSON.stringify(accepts);
  if (sig !== appliedSig || appliedMode !== "enforce") {
    await populateFamily("inet", accepts.v4);
    const v6 = await populateFamily("inet6", accepts.v6).then(() => true).catch(() => false);
    v6Ok = v6;
    if (!v6Ok) write({ event: "egress.enforce.v6_unavailable" });
    prevDenied = { inet: 0, inet6: 0 };
    appliedMode = "enforce";
    appliedSig = sig;
    write({
      event: "egress.enforce.sync", mode: "enforce",
      allow: { hosts: allow.hosts, literals: allow.literals.map((l) => l.addr), infra: INFRA_HOSTS },
      accept: { v4: accepts.v4, v6: v6Ok ? accepts.v6 : "unavailable" },
    });
  }

  // Surface denials (packet counters only reset when we rebuild the chain).
  let delta = 0;
  for (const fam of v6Ok ? ["inet", "inet6"] : ["inet"]) {
    const cur = await readDenied(fam);
    if (cur >= prevDenied[fam]) delta += cur - prevDenied[fam];
    prevDenied[fam] = cur;
  }
  if (delta > 0) {
    deniedCumulative += delta;
    write({ event: "egress.denied", newlyBlocked: delta, totalBlocked: deniedCumulative });
  }
}

async function reconcileLoop() {
  for (;;) {
    await reconcile().catch((e) => console.error("[egress] reconcile error:", e.message));
    await new Promise((r) => setTimeout(r, RECONCILE_MS));
  }
}

async function shutdown() {
  // Leave enforcement in place on SIGTERM: the rules live in the (still-running)
  // agent's namespace, so the agent stays contained until this sidecar restarts
  // and re-syncs. Only tcpdump is ours to stop.
  tcpdump.kill("SIGTERM");
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.error(`[egress] logging -> ${LOG_DIR}/egress-<date>.jsonl; mode from EGRESS_MODE/${POLICY_FILE}`);
reconcileLoop();
