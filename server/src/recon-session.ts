/**
 * A logged-in session for a recon target: the cookies (and, if the app uses one, the
 * Authorization header) of a browser the person logged in with themselves, so the test can
 * go past the login screen, 2FA included.
 *
 * How it gets here: the person asks the runner for a pairing code for one target, pastes it
 * into the BugXHunter browser extension, logs in to the target and presses send. The
 * extension posts the session with the code; the code is single-use, expires in ten
 * minutes, and only accepts a session for the target it was issued for.
 *
 * Where it lives: sealed with the vault key next to the vault (sessions/, on the runner-only
 * volume in Docker), one file per target, nothing about the target in the clear. For a run
 * it is written into the project folder as two files curl can read (a cookie jar and a
 * header file) and removed when the run ends. The values are never put in a prompt; the
 * agent is given the file names. It can still read the files: use a test account.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Sealed } from "../../shared/vault.js";
import type { ReconSessionInfo } from "../../shared/agent.js";
import { VAULT_FILE, isInitialised, isUnsealed, openData, sealData } from "./vault.js";
import { httpError } from "./errors.js";
import { audit } from "./audit.js";
import { originOf, type ReconSessionUse } from "./recon.js";

const dir = () => process.env.OPEN_RUNNER_SESSION_DIR ?? path.join(path.dirname(VAULT_FILE), "sessions");

export const PAIRING_TTL_MS = 10 * 60_000;
const MAX_PAIRINGS = 5;
const MAX_COOKIES = 150;
const MAX_VALUE = 8192;
const MAX_TARGETS = 100;
/** The folder, inside the project, that holds session files: one subfolder per run. */
export const SESSION_FOLDER = ".bugxhunter";
const ID = /^[a-f0-9]{24}$/;

export interface CapturedCookie {
  name: string;
  value: string;
  /** The cookie's domain, without a leading dot. */
  domain: string;
  /** False for a host-only cookie (sent to exactly `domain`), true when subdomains get it too. */
  subdomains: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Expiry in seconds since the epoch; absent for a session cookie. */
  expires?: number;
}

export interface CapturedSession {
  /** host:port of the target it was captured for. */
  target: string;
  capturedAt: number;
  cookies: CapturedCookie[];
  /** The value of the Authorization header the app sent, e.g. "Bearer …". */
  authorization?: string;
}

const key = (scope: string): string | undefined => {
  const { host, port } = originOf(scope.trim());
  return host ? `${host}:${port}` : undefined;
};

/* ─────────────── reading what the extension sent ─────────────── */

/** A cookie name, per RFC 6265: a token. */
const NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/;
/** No control characters, so a value can never start a new line in the jar or the header file. */
const CLEAN = /^[^\x00-\x1f\x7f]*$/;
const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

/** Would a cookie with this domain be sent to `host`? */
function sentTo(host: string, domain: string, subdomains: boolean): boolean {
  return host === domain || (subdomains && host.endsWith(`.${domain}`));
}

/**
 * Validate a capture and keep only what belongs to the target: cookies the browser would
 * send to its host, with clean names and values. Anything malformed is dropped, and a
 * capture with nothing usable left is refused.
 */
export function parseCapture(raw: unknown, scope: string, now = Date.now()): CapturedSession {
  const target = key(scope);
  const host = originOf(scope).host;
  if (!target || !host) throw httpError(400, "The pairing code is not for a valid target.");
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const from = typeof r.origin === "string" ? key(r.origin) : undefined;
  if (from !== target) throw httpError(400, `This pairing code is for ${target}. Open that site's tab and send again.`);

  const cookies: CapturedCookie[] = [];
  for (const c of Array.isArray(r.cookies) ? r.cookies.slice(0, 1000) : []) {
    const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : "";
    const value = typeof o.value === "string" ? o.value : "";
    const rawDomain = typeof o.domain === "string" ? o.domain.trim().toLowerCase() : "";
    const domain = rawDomain.replace(/^\./, "");
    const subdomains = o.hostOnly === false || (o.hostOnly === undefined && rawDomain.startsWith("."));
    const p = typeof o.path === "string" && o.path.startsWith("/") ? o.path : "/";
    if (!NAME.test(name) || value.length > MAX_VALUE || !CLEAN.test(value) || /\s/.test(value)) continue;
    if (!HOST.test(domain) || !sentTo(host, domain, subdomains)) continue;
    if (p.length > 1024 || !CLEAN.test(p) || /\s/.test(p)) continue;
    const expires = typeof o.expirationDate === "number" && Number.isFinite(o.expirationDate) ? Math.floor(o.expirationDate) : undefined;
    if (expires !== undefined && expires * 1000 <= now) continue; // already expired
    cookies.push({ name, value, domain, subdomains, path: p, secure: o.secure === true, httpOnly: o.httpOnly === true, ...(expires !== undefined ? { expires } : {}) });
    if (cookies.length >= MAX_COOKIES) break;
  }
  const auth = typeof r.authorization === "string" ? r.authorization.trim() : "";
  const authorization = auth && auth.length <= MAX_VALUE && CLEAN.test(auth) ? auth : undefined;
  if (!cookies.length && !authorization) throw httpError(400, "Nothing to capture: no cookies for this site and no Authorization header seen. Log in first, then send.");
  return { target, capturedAt: now, cookies, ...(authorization ? { authorization } : {}) };
}

/* ─────────────── pairing codes ─────────────── */

interface Pairing { scope: string; target: string; expiresAt: number }
const pairings = new Map<string, Pairing>();
const digest = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** A single-use code the extension sends a session with. Good for one target, for ten minutes. */
export function issuePairing(scope: string, now = Date.now()): { token: string; target: string; expiresAt: number } {
  const target = key(scope);
  if (!target) throw httpError(400, "scope must be one host or URL");
  if (!isInitialised()) throw httpError(409, "Set up the vault (sidebar → keys) first: a captured session is encrypted with it.");
  if (!isUnsealed()) throw httpError(503, "The vault is sealed (locked). Unlock it to capture a session.");
  for (const [k, p] of pairings) if (p.expiresAt <= now) pairings.delete(k);
  while (pairings.size >= MAX_PAIRINGS) pairings.delete(pairings.keys().next().value!);
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = now + PAIRING_TTL_MS;
  pairings.set(digest(token), { scope: scope.trim(), target, expiresAt });
  audit("recon.session.pairing", {});
  return { token, target, expiresAt };
}

/** The extension's post: check the code, keep the session, and spend the code. */
export function redeem(token: unknown, raw: unknown, now = Date.now()): ReconSessionInfo {
  const id = typeof token === "string" && token ? digest(token) : "";
  const p = pairings.get(id);
  if (!p || p.expiresAt <= now) {
    if (p) pairings.delete(id);
    audit("recon.session.refused", { reason: "code" });
    throw httpError(401, "That pairing code is not valid or has expired. Get a new one in BugXHunter's recon dialog.");
  }
  const session = parseCapture(raw, p.scope, now); // a bad capture leaves the code usable: fix and resend
  save(session);
  pairings.delete(id);
  audit("recon.session.captured", { cookies: session.cookies.length, authorization: Boolean(session.authorization) });
  return info(session);
}

/* ─────────────── the sealed store ─────────────── */

interface SessionFile { v: 1; id: string; body: Sealed }
const aad = (id: string) => `recon-session:${id}:body`;
const file = (id: string) => path.join(dir(), `${id}.json`);

function stored(): { id: string; session: CapturedSession }[] {
  if (isInitialised() && !isUnsealed()) throw httpError(503, "The vault is sealed (locked). Unlock it to use a captured session.");
  let names: string[];
  try { names = fs.readdirSync(dir()); } catch { return []; }
  const out: { id: string; session: CapturedSession }[] = [];
  for (const name of names) {
    const id = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (!ID.test(id)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(file(id), "utf8")) as SessionFile;
      if (r?.v !== 1 || r.id !== id) continue;
      const session = JSON.parse(openData(r.body, aad(id))) as CapturedSession;
      if (typeof session?.target === "string" && Array.isArray(session.cookies)) out.push({ id, session });
    } catch (e) {
      if ((e as { status?: number }).status === 503) throw e;
    }
  }
  return out;
}

function save(session: CapturedSession): void {
  const all = stored();
  const prev = all.find((s) => s.session.target === session.target);
  if (!prev && all.length >= MAX_TARGETS) throw httpError(409, `Sessions for up to ${MAX_TARGETS} targets are kept; forget some first.`);
  const id = prev?.id ?? crypto.randomBytes(12).toString("hex");
  const record: SessionFile = { v: 1, id, body: sealData(JSON.stringify(session), aad(id)) };
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const tmp = `${file(id)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, file(id));
}

function info(s: CapturedSession): ReconSessionInfo {
  const expiries = s.cookies.map((c) => c.expires).filter((e): e is number => e !== undefined);
  return {
    target: s.target, capturedAt: s.capturedAt, cookies: s.cookies.length, authorization: Boolean(s.authorization),
    ...(expiries.length ? { firstExpiry: Math.min(...expiries) * 1000 } : {}),
  };
}

function find(scope: string): CapturedSession | undefined {
  const target = key(scope);
  return target ? stored().find((s) => s.session.target === target)?.session : undefined;
}

/** What is held for a target, without any value. Throws 503 while the vault is locked. */
export function sessionInfo(scope: string): ReconSessionInfo | null {
  const s = find(scope);
  return s ? info(s) : null;
}

/** Forget the session held for a target. */
export function forgetSession(scope: string): boolean {
  const target = key(scope);
  const hit = target ? stored().find((s) => s.session.target === target) : undefined;
  if (!hit) return false;
  fs.rmSync(file(hit.id), { force: true });
  audit("recon.session.forgotten", {});
  return true;
}

/* ─────────────── handing it to a run ─────────────── */

/**
 * The cookies as a Netscape cookie jar, the format `curl -b <file>` reads: curl then sends
 * each cookie only where its domain, path and secure flag allow, as the browser would.
 * Expired cookies are left out. A session cookie has expiry 0.
 */
export function cookieJar(cookies: readonly CapturedCookie[], now = Date.now()): string {
  const lines = ["# Netscape HTTP Cookie File", "# Written by BugXHunter for one recon run. Removed when the run ends."];
  for (const c of cookies) {
    if (c.expires !== undefined && c.expires * 1000 <= now) continue;
    const domain = `${c.httpOnly ? "#HttpOnly_" : ""}${c.subdomains ? "." : ""}${c.domain}`;
    lines.push([domain, c.subdomains ? "TRUE" : "FALSE", c.path, c.secure ? "TRUE" : "FALSE", String(c.expires ?? 0), c.name, c.value].join("\t"));
  }
  return lines.join("\n") + "\n";
}

/**
 * Write a target's session into the project folder for one run, and say where. Returns
 * undefined when nothing is held for the target (or the vault is locked: a run never
 * fails for want of a session it was only offered). `cleanup` removes the files.
 */
export function materialise(scope: string, directory: string, now = Date.now()): ReconSessionUse | undefined {
  let s: CapturedSession | undefined;
  try { s = find(scope); } catch { return undefined; }
  if (!s) return undefined;
  const live = s.cookies.filter((c) => c.expires === undefined || c.expires * 1000 > now);
  if (!live.length && !s.authorization) return undefined;

  // One folder per run, so two runs in the same project never share or remove each other's files.
  const rel = `${SESSION_FOLDER}/session-${crypto.randomBytes(4).toString("hex")}`;
  const folder = path.join(directory, ...rel.split("/"));
  fs.mkdirSync(folder, { recursive: true });
  // Keeps the folder out of the project's changes and commits.
  const ignore = path.join(path.dirname(folder), ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  const use: ReconSessionUse = { capturedAt: s.capturedAt, cookies: live.length, authorization: Boolean(s.authorization), cleanup: () => fs.rmSync(folder, { recursive: true, force: true }) };
  if (live.length) {
    fs.writeFileSync(path.join(folder, "cookies.txt"), cookieJar(live, now), { mode: 0o600 });
    use.cookieFile = `${rel}/cookies.txt`;
  }
  if (s.authorization) {
    fs.writeFileSync(path.join(folder, "headers.txt"), `Authorization: ${s.authorization}\n`, { mode: 0o600 });
    use.headerFile = `${rel}/headers.txt`;
  }
  audit("recon.session.used", { cookies: live.length, authorization: Boolean(s.authorization) });
  return use;
}
