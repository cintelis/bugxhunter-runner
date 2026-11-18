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
 *      loopback and DNS (pinned to the configured resolvers) are allowed, plus
 *      each allow-listed destination (the in-scope target and any operator "also
 *      allow" host); everything else is REJECTed. Default is "monitor"
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
import net from "node:net";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  readPolicy, buildChainRules, renderRestore, ipAllowed, isV6, EGRESS_CHAIN,
} from "./egress-filter.mjs";

const LOG_DIR = process.env.OPEN_RUNNER_LOG_DIR ?? "/workspace/logs";
const POLICY_FILE = process.env.EGRESS_POLICY_FILE ?? path.join(LOG_DIR, "egress-policy.json");
const RECONCILE_MS = Math.max(5000, Number(process.env.EGRESS_RECONCILE_MS) || 30000);
// Infra the agent must always reach under enforce: the runner (model proxy) and
// any extra operator-named hosts. Resolved and allowed independent of EGRESS_ALLOW.
const INFRA_HOSTS = (process.env.EGRESS_INFRA_HOSTS ?? "runner").split(/[\s,]+/).filter(Boolean);
// Extra upstream resolver IPs to allow on port 53 under enforce. On a compose
// network /etc/resolv.conf lists only Docker's embedded 127.0.0.11, which
// forwards upstream from inside this shared namespace — those forwarded queries
// traverse the chain, so set EGRESS_DNS to the real upstream resolver(s) (or give
// the agent an explicit `dns:` so they appear in resolv.conf directly).
const EXTRA_DNS = (process.env.EGRESS_DNS ?? "").split(/[\s,]+/).filter((s) => net.isIP(s));
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
const ipt = (fam, args) => run(fam === "inet6" ? "ip6tables" : "iptables", ["-w", "5", ...args]);

// Spawn a binary and feed `input` on stdin (used for iptables-restore).
function runInput(bin, args, input) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => resolve({ code: -1, out, err: e.message }));
    p.on("exit", (code) => resolve({ code: code ?? -1, out, err }));
    p.stdin.on("error", () => {}); // ignore EPIPE if the binary is missing
    p.stdin.end(input);
  });
}

// Resolver IPs to allow on port 53: /etc/resolv.conf nameservers + EGRESS_DNS,
// split by family, validated with net.isIP, excluding loopback (Docker's
// embedded 127.0.0.11 is already covered by the `-o lo` accept).
function readResolvers() {
  const v4 = [], v6 = [];
  const add = (ip) => {
    const fam = net.isIP(ip);
    if (fam === 4 && !/^127\./.test(ip)) v4.push(ip);
    else if (fam === 6 && ip !== "::1") v6.push(ip);
  };
  let text = "";
  try { text = fs.readFileSync("/etc/resolv.conf", "utf8"); } catch { /* none */ }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*nameserver\s+(\S+)/);
    if (m) add(m[1]);
  }
  for (const ip of EXTRA_DNS) add(ip);
  return { v4: [...new Set(v4)], v6: [...new Set(v6)] };
}

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

// Apply one family's chain as a single kernel transaction (no empty-chain
// window), then ensure OUTPUT jumps to it. Throws on any failure so the caller
// never falsely reports enforcement.
async function applyFamily(fam, accepts, dnsAddrs) {
  const restoreBin = fam === "inet6" ? "ip6tables-restore" : "iptables-restore";
  const text = renderRestore(buildChainRules(accepts, fam, dnsAddrs));
  const r = await runInput(restoreBin, ["-w", "5", "--noflush"], text);
  if (r.code === -1) throw new Error(`${fam} tables unavailable: ${r.err}`);        // binary missing
  if (r.code !== 0) throw new Error(`${fam} restore failed: ${r.err.trim()}`);       // bad ruleset / no perms
  // The chain now exists; make sure OUTPUT jumps to it exactly once.
  const has = await ipt(fam, ["-C", "OUTPUT", "-j", EGRESS_CHAIN]);
  if (has.code !== 0) {
    const ins = await ipt(fam, ["-I", "OUTPUT", "1", "-j", EGRESS_CHAIN]);
    if (ins.code !== 0) throw new Error(`${fam} jump install failed: ${ins.err.trim()}`);
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
let lastGoodPolicy = null; // the last policy we successfully reconciled

async function reconcile() {
  // Classify the policy file read: a genuinely absent file (ENOENT) is normal
  // (mode comes from env); a read error (EIO/EACCES/EISDIR) or an empty/truncated
  // file is a PROBLEM — don't treat it as "no file" and tear enforcement down.
  let fileText, fileProblem = false;
  try { fileText = await fsp.readFile(POLICY_FILE, "utf8"); }
  catch (e) { if (e.code !== "ENOENT") fileProblem = true; fileText = undefined; }
  if (fileText !== undefined && fileText.trim() === "") { fileProblem = true; fileText = undefined; }

  const parsed = readPolicy(process.env, fileText);
  const invalid = parsed.fileInvalid || fileProblem;

  // On any invalid/problem read, hold the last-good policy (so a torn read never
  // tears the chain down) and keep running the full cycle with it — re-resolving,
  // tracking resolvers and counting denials — rather than freezing.
  let effective;
  if (invalid) {
    write({ event: "egress.policy_invalid", file: POLICY_FILE });
    effective = lastGoodPolicy ?? { mode: parsed.mode, allow: parsed.allow };
  } else {
    effective = { mode: parsed.mode, allow: parsed.allow };
  }
  currentAllow = effective.allow;

  if (effective.mode === "monitor") {
    // Tear down BOTH families from kernel state (idempotent), so a stale chain
    // from an earlier enforce run can't survive — even across a sidecar restart.
    const wasEnforce = appliedMode === "enforce";
    await teardownFamily("inet");
    await teardownFamily("inet6");
    if (wasEnforce) write({ event: "egress.mode", mode: "monitor" });
    appliedMode = "monitor"; appliedSig = ""; v6Ok = true;
    lastGoodPolicy = effective;
    return;
  }

  // enforce
  const accepts = await resolveAccepts(effective.allow);
  const resolvers = readResolvers();
  const sig = JSON.stringify({ accepts, resolvers });
  const fresh = sig !== appliedSig || appliedMode !== "enforce";

  // IPv4: (re)apply on change, or if the OUTPUT jump has gone missing (e.g. the
  // agent's namespace was recreated) — verifying every cycle re-contains it.
  const jumpOk = appliedMode === "enforce" && (await ipt("inet", ["-C", "OUTPUT", "-j", EGRESS_CHAIN])).code === 0;
  if (fresh || !jumpOk) {
    try {
      await applyFamily("inet", accepts.v4, resolvers.v4);
    } catch (e) {
      // IPv4 enforcement failed: do NOT claim enforce. Leave any existing rules
      // in place, surface it (so the runner can halt) and retry next cycle.
      write({ event: "egress.enforce.failed", family: "inet", error: e.message });
      return;
    }
  }
  // IPv6: (re)apply on change or while it is not yet healthy (retry), logging the
  // real error instead of silently swallowing it.
  if (fresh || !v6Ok) {
    v6Ok = await applyFamily("inet6", accepts.v6, resolvers.v6).then(() => true)
      .catch((e) => { write({ event: "egress.enforce.v6_error", error: e.message }); return false; });
  }

  if (fresh) {
    prevDenied = { inet: 0, inet6: 0 };
    write({
      event: "egress.enforce.sync", mode: "enforce",
      allow: { hosts: effective.allow.hosts, literals: effective.allow.literals.map((l) => l.addr), infra: INFRA_HOSTS },
      accept: { v4: accepts.v4, v6: v6Ok ? accepts.v6 : "unavailable" }, resolvers,
    });
  }
  appliedMode = "enforce";
  appliedSig = sig;
  lastGoodPolicy = effective;

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
