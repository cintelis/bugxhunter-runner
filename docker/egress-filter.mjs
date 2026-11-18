/**
 * Pure egress-allowlist logic for the enforce-mode sidecar.
 *
 * NO I/O and no side-effecting imports live here, so the server workspace can
 * unit-test it directly (server/src/egress-filter.test.ts). The sidecar
 * (egress-logger.mjs) imports these helpers and does the actual DNS resolution,
 * `iptables` calls and logging.
 *
 * Model: egress has two modes.
 *   - monitor (default): nothing is blocked; the sidecar only logs.
 *   - enforce (opt-in):  a deny-by-default `BXH_EGRESS` chain is installed in the
 *     agent's network namespace. Loopback, already-established flows and DNS are
 *     allowed; so is each allow-listed destination (the in-scope target plus any
 *     operator "also allow" host — e.g. an out-of-band collaborator). Everything
 *     else is REJECTed and rate-logged.
 */

/** Recognise an explicit mode, or null for a non-empty value we don't know. */
export function recognizedMode(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "enforce") return "enforce";
  if (v === "monitor" || v === "") return "monitor";
  return null;
}

/** Normalise the mode string. Unknown / empty → monitor (fail-safe default). */
export function egressMode(raw) {
  return recognizedMode(raw) ?? "monitor";
}

/** True for a string that looks like an IPv6 literal or IPv6 CIDR. */
export function isV6(s) {
  return s.includes(":");
}

function validV4(ip) {
  const p = ip.split(".");
  return p.length === 4 && p.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}

/**
 * Parse a comma/whitespace-separated allow list into:
 *   { hosts:   ["example.com", ...],            // resolved at runtime
 *     literals:[{ addr: "1.2.3.0/24", family }]} // passed straight to iptables -d
 * Accepts bare hosts, IPv4/IPv6 addresses and CIDRs, and tolerates a pasted
 * scheme (https://…), a trailing path and a :port. Junk entries are dropped.
 */
export function parseAllow(raw) {
  const hosts = [];
  const literals = [];
  for (const token of String(raw ?? "").split(/[\s,]+/)) {
    let t = token.trim().toLowerCase();
    if (!t) continue;
    t = t.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme if a URL was pasted

    // IPv4 CIDR (keep the /prefix; iptables -d understands it).
    if (/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(t)) {
      const [ip, bits] = t.split("/");
      if (validV4(ip) && Number(bits) <= 32) literals.push({ addr: t, family: "inet" });
      continue;
    }
    // IPv6 literal or CIDR (contains a colon). iptables -d handles the CIDR.
    if (isV6(t) && /^[0-9a-f:]+(\/\d{1,3})?$/.test(t)) {
      const bits = t.includes("/") ? Number(t.split("/")[1]) : 128;
      if (bits <= 128) literals.push({ addr: t, family: "inet6" });
      continue;
    }

    t = t.replace(/\/.*$/, ""); // strip a trailing path from host[:port]/path
    const port = t.match(/^(.+):(\d+)$/); // strip a :port (IPv4 host only; v6 handled above)
    if (port) t = port[1];

    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) {
      if (validV4(t)) literals.push({ addr: t, family: "inet" });
    } else if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(t)) {
      hosts.push(t);
    }
  }
  return { hosts: dedupe(hosts), literals: dedupeLiterals(literals) };
}

function dedupe(xs) {
  return [...new Set(xs)];
}
function dedupeLiterals(xs) {
  const seen = new Set();
  const out = [];
  for (const l of xs) {
    const k = `${l.family}|${l.addr}`;
    if (!seen.has(k)) { seen.add(k); out.push(l); }
  }
  return out;
}

/** Decide mode + allow list from the sidecar's env and an optional policy file.
 *  A valid policy file (JSON {mode?, allow?}) is the runtime toggle: the runner
 *  writes it, the sidecar re-reads it each cycle. Two safety rules:
 *   - env EGRESS_MODE=enforce is a FLOOR — the file can raise to enforce but
 *     never lower to monitor (so a stray/hostile file can't disable containment);
 *   - a malformed file, or an unknown `mode`, is reported via `fileInvalid` and
 *     its contents are ignored (the caller holds its last-good state rather than
 *     tearing enforcement down on a torn read). */
export function readPolicy(env, fileText) {
  const envMode = egressMode(env.EGRESS_MODE);
  let mode = envMode;
  let allowRaw = env.EGRESS_ALLOW ?? "";
  let fileInvalid = false;

  if (fileText != null && String(fileText).trim() !== "") {
    let j;
    try { j = JSON.parse(fileText); } catch { j = undefined; }
    if (!j || typeof j !== "object" || Array.isArray(j)) {
      fileInvalid = true;
    } else {
      if (j.mode !== undefined) {
        const fm = recognizedMode(j.mode);
        if (fm === null) fileInvalid = true;
        else mode = fm;
      }
      if (j.allow !== undefined) allowRaw = Array.isArray(j.allow) ? j.allow.join(",") : String(j.allow);
    }
  }

  if (envMode === "enforce") mode = "enforce";            // env floor
  if (fileInvalid) { mode = envMode; allowRaw = env.EGRESS_ALLOW ?? ""; } // ignore the bad file
  return { mode, allow: parseAllow(allowRaw), fileInvalid };
}

/* ───────── IPv4 helpers (used to tag monitor-mode connect logs) ───────── */

export function ip4ToInt(ip) {
  if (!validV4(ip)) return null;
  const p = ip.split(".").map(Number);
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

export function ipInCidr(ip, cidr) {
  const [net, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const a = ip4ToInt(ip);
  const b = ip4ToInt(net);
  if (a === null || b === null || !(bits >= 0 && bits <= 32)) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

/** Best-effort "is this IPv4 destination in the allow set?" for log tagging. */
export function ipAllowed(ip, allow) {
  for (const l of allow.literals) {
    if (l.family !== "inet") continue;
    if (l.addr.includes("/") ? ipInCidr(ip, l.addr) : l.addr === ip) return true;
  }
  return false;
}

/* ───────── iptables rule-building (pure: returns arg arrays) ───────── */

const CHAIN = "BXH_EGRESS";

/**
 * Build the ordered list of rules for one address family's BXH_EGRESS chain.
 * Returns arrays of `iptables`/`ip6tables` arguments, in order.
 *
 *   `acceptAddrs` — resolved destinations to allow (IPs/CIDRs of this family),
 *                   reachable on any port (pentest targets need every port).
 *   `dnsAddrs`    — resolver IPs of this family to allow on port 53 only. DNS is
 *                   NOT opened to every host (that would be a trivial bypass:
 *                   `curl http://evil:53`); only the configured resolvers.
 *
 * Shape: allow loopback, then DNS to the pinned resolvers, then each
 * destination, then rate-log and REJECT the rest. There is deliberately NO
 * blanket ESTABLISHED,RELATED accept — in an OUTPUT, destination-based chain a
 * legitimate flow already matches its `-d` rule, whereas a broad ESTABLISHED
 * accept would keep monitor-era tunnels alive across a flip and survive an
 * allowlist shrink. Dropping it means removing a host cuts its live flows too.
 */
export function buildChainRules(acceptAddrs, family = "inet", dnsAddrs = []) {
  const reject = family === "inet6" ? "icmp6-adm-prohibited" : "icmp-admin-prohibited";
  const rules = [["-A", CHAIN, "-o", "lo", "-j", "ACCEPT"]];
  for (const ns of dnsAddrs) {
    rules.push(["-A", CHAIN, "-d", ns, "-p", "udp", "--dport", "53", "-j", "ACCEPT"]);
    rules.push(["-A", CHAIN, "-d", ns, "-p", "tcp", "--dport", "53", "-j", "ACCEPT"]);
  }
  for (const addr of acceptAddrs) rules.push(["-A", CHAIN, "-d", addr, "-j", "ACCEPT"]);
  // Space-free prefix so the rule survives `iptables-restore` without quoting.
  rules.push(["-A", CHAIN, "-m", "limit", "--limit", "6/min", "-j", "LOG", "--log-prefix", "bxh-egress-deny:"]);
  rules.push(["-A", CHAIN, "-j", "REJECT", "--reject-with", reject]);
  return rules;
}

/**
 * Render a chain's rules as an `iptables-restore --noflush` document. The
 * `:BXH_EGRESS - [0:0]` line creates-or-flushes the chain and the whole block
 * is applied as ONE kernel transaction, so the chain is never momentarily empty
 * (no fall-through-to-ACCEPT window during a rebuild). Rules for other chains
 * are untouched (--noflush); the OUTPUT jump is managed separately.
 */
export function renderRestore(rules) {
  const body = rules.map((r) => r.join(" ")).join("\n");
  return `*filter\n:${CHAIN} - [0:0]\n${body}\nCOMMIT\n`;
}

export const EGRESS_CHAIN = CHAIN;
