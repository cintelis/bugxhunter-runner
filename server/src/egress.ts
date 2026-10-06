/**
 * Approval-gated internet access for the sandboxed agent.
 * -----------------------------------------------------------------------------
 * The agent container has no route to the internet (and no DNS). Its
 * HTTP_PROXY/HTTPS_PROXY point here: a small forward proxy (CONNECT for HTTPS,
 * absolute-URL requests for plain HTTP). The first connection to a host shows
 * an approval card in the UI:
 *
 *   allow for this session · always allow · deny
 *
 * A connection waits up to HOLD_MS for the answer — shorter than the agent's
 * tool timeouts — then gets a clear "awaiting approval" refusal so the agent
 * can tell the user and retry. The card itself stays up for PENDING_TTL_MS, so
 * approving after the agent gave up still works on its next attempt.
 *
 * Decisions are per host (any port). "Always"/"deny" rules persist to
 * EGRESS_RULES_FILE; session approvals last until this server restarts.
 */
import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { audit } from "./audit.js";

export type Decision = "session" | "always" | "deny";

export interface EgressRequest {
  id: string;
  host: string;
  ports: number[];
  /** Resolved address is loopback/private/link-local (LAN, Docker, the host machine). */
  privateAddress: boolean;
  address?: string;
  attempts: number;
  firstSeen: number;
  /** Connections currently held open waiting for the answer. */
  waiting: number;
  /** When the card expires if nobody answers (ms since epoch). */
  expires: number;
}

export interface EgressRule {
  host: string;
  decision: Decision;
  at: number;
}

const RULES_FILE = process.env.EGRESS_RULES_FILE ?? "/data/egress-rules.json";
const HOLD_MS = Number(process.env.EGRESS_HOLD_MS ?? 25_000);
const PENDING_TTL_MS = Number(process.env.EGRESS_PENDING_TTL_MS ?? 10 * 60_000);
/** Hosts the agent always reaches directly (its own model proxy). */
const ALWAYS_ALLOWED = new Set(["runner", "localhost", "127.0.0.1"]);

export const egressEvents = new EventEmitter();
egressEvents.setMaxListeners(100);

type Outcome = "allow" | "deny" | "pending";
interface Pending { req: EgressRequest; waiters: Set<(o: Outcome) => void>; expiry: NodeJS.Timeout }

const rules = new Map<string, EgressRule>();
const pending = new Map<string, Pending>();
let seq = 0;

function loadRules() {
  try {
    for (const r of JSON.parse(fs.readFileSync(RULES_FILE, "utf8")) as EgressRule[]) rules.set(r.host, r);
  } catch { /* no rules yet */ }
}
function saveRules() {
  const persistent = [...rules.values()].filter((r) => r.decision !== "session");
  try {
    fs.mkdirSync(path.dirname(RULES_FILE), { recursive: true });
    fs.writeFileSync(RULES_FILE, JSON.stringify(persistent, null, 2));
  } catch (e) {
    console.error("[egress] could not save rules:", (e as Error).message);
  }
}

export const listRules = () => [...rules.values()].sort((a, b) => a.host.localeCompare(b.host));
export const listPending = () => [...pending.values()].map((p) => p.req);

export function removeRule(host: string) {
  rules.delete(host.toLowerCase());
  saveRules();
  egressEvents.emit("rules", listRules());
}

/** Record the user's answer and release every connection waiting on that host. */
export function decide(host: string, decision: Decision) {
  host = host.toLowerCase();
  audit("network.decision", { host, decision });
  rules.set(host, { host, decision, at: Date.now() });
  if (decision !== "session") saveRules();
  const p = pending.get(host);
  if (p) {
    clearTimeout(p.expiry);
    pending.delete(host);
    p.waiters.forEach((w) => w(decision === "deny" ? "deny" : "allow"));
  }
  egressEvents.emit("resolved", { host, decision });
  egressEvents.emit("rules", listRules());
}

function isPrivate(ip: string) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.");
}

/** Decide whether `host` may be reached, asking the user if there is no rule yet. */
async function authorize(host: string, port: number, socket?: net.Socket): Promise<Outcome> {
  host = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (ALWAYS_ALLOWED.has(host)) return "allow";
  const rule = rules.get(host);
  if (rule) {
    if (rule.decision === "deny") audit("network.blocked", { host, port });
    return rule.decision === "deny" ? "deny" : "allow";
  }

  let entry = pending.get(host);
  if (!entry) {
    let address: string | undefined;
    try { address = (await dns.lookup(host)).address; } catch { /* unresolvable */ }
    // Another request may have created it while we were resolving.
    entry = pending.get(host);
    if (!entry) {
      const now = Date.now();
      const created: Pending = {
        req: {
          id: `egr_${++seq}`, host, ports: [port], address,
          privateAddress: address ? isPrivate(address) : false,
          attempts: 0, firstSeen: now, waiting: 0, expires: now + PENDING_TTL_MS,
        },
        waiters: new Set(),
        expiry: setTimeout(() => {
          // Nobody answered: drop the card; the next attempt asks again.
          if (pending.get(host) === created) {
            pending.delete(host);
            created.waiters.forEach((w) => w("pending"));
            egressEvents.emit("resolved", { host, decision: "expired" });
          }
        }, PENDING_TTL_MS),
      };
      pending.set(host, created);
      entry = created;
      audit("network.request", { host, port, address, private: created.req.privateAddress });
    }
  }
  const current = entry;
  if (!current.req.ports.includes(port)) current.req.ports.push(port);
  current.req.attempts++;

  return new Promise<Outcome>((resolve) => {
    let settled = false;
    const finish = (o: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(hold);
      socket?.off("end", gone);
      socket?.off("close", gone);
      current.waiters.delete(finish);
      current.req.waiting = current.waiters.size;
      if (pending.get(host) === current) egressEvents.emit("pending", current.req);
      resolve(o);
    };
    // Hold the connection a while, then refuse with "awaiting approval" so the
    // agent's tool doesn't just time out. The card stays up.
    const hold = setTimeout(() => finish("pending"), HOLD_MS);
    // HTTP server sockets are half-open: a client hanging up shows as "end".
    const gone = () => finish("pending");
    socket?.once("end", gone);
    socket?.once("close", gone);
    current.waiters.add(finish);
    current.req.waiting = current.waiters.size;
    egressEvents.emit("pending", current.req);
  });
}

function refusal(host: string, outcome: Outcome) {
  return outcome === "deny"
    ? { reason: "Blocked by user", body: `Open Runner: the user denied internet access to ${host}. Do not retry; ask the user if you need it.\n` }
    : { reason: "Awaiting user approval", body: `Open Runner: access to ${host} is waiting for the user's approval in the Open Runner UI. Tell the user you need ${host}, then retry after they approve.\n` };
}

/** Start the forward proxy the agent container uses as HTTP(S)_PROXY. */
export function startEgressProxy(port: number) {
  loadRules();

  const server = http.createServer(async (req, res) => {
    // A client that hangs up while waiting for approval must not crash us.
    req.on("error", () => {});
    res.on("error", () => {});
    // Plain-HTTP proxying: the request line carries an absolute URL.
    let url: URL;
    try { url = new URL(req.url ?? ""); } catch {
      res.writeHead(400).end("Open Runner egress proxy: absolute URL required\n");
      return;
    }
    const target = Number(url.port || 80);
    const outcome = await authorize(url.hostname, target, req.socket);
    if (outcome !== "allow") {
      if (req.socket.destroyed) return;
      const r = refusal(url.hostname, outcome);
      res.writeHead(403, r.reason, { "Content-Type": "text/plain" }).end(r.body);
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = http.request(
      { host: url.hostname, port: target, method: req.method, path: url.pathname + url.search, headers },
      (up) => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res); },
    );
    upstream.on("error", (e) => { if (!res.headersSent) res.writeHead(502); res.end(`upstream error: ${e.message}\n`); });
    req.pipe(upstream);
  });

  // HTTPS (and any TLS/TCP) via CONNECT host:port.
  server.on("connect", async (req, client, head) => {
    // Handle errors from the moment the socket arrives: the agent may hang up
    // (timeout, Ctrl+C) while the request is still waiting for approval.
    let upstream: net.Socket | null = null;
    client.on("error", () => upstream?.destroy());
    client.on("close", () => upstream?.destroy());
    // Keep the socket flowing while we wait, so a hang-up is noticed (a paused
    // socket never reports it); buffer anything the client sends early.
    const early: Buffer[] = [];
    const onEarly = (c: Buffer) => early.push(c);
    client.on("data", onEarly);

    const [host, portStr] = (req.url ?? "").split(/:(?=\d+$)/);
    const target = Number(portStr || 443);
    const outcome: Outcome = host ? await authorize(host, target, client as net.Socket) : "deny";
    if (client.destroyed || client.readableEnded) {
      client.destroy();
      return;
    }
    if (outcome !== "allow") {
      const r = refusal(host ?? "?", outcome);
      client.end(`HTTP/1.1 403 ${r.reason}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(r.body)}\r\n\r\n${r.body}`);
      return;
    }
    upstream = net.connect(target, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream!.write(head);
      client.off("data", onEarly);
      for (const c of early) upstream!.write(c);
      upstream!.pipe(client);
      client.pipe(upstream!);
    });
    upstream.on("error", () => {
      if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
  });
  server.on("clientError", (_err, socket) => socket.destroy());

  server.listen(port, "0.0.0.0", () => console.log(`  egress proxy (approval-gated) on :${port}`));
  return server;
}
