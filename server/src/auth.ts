/**
 * Simple single-password login.
 *
 * Enabled when OPEN_RUNNER_PASSWORD is set (always, in Docker). A successful
 * login sets an HttpOnly, SameSite=Strict cookie holding `<expiry>.<hmac>`;
 * every /api route except /api/auth/* and /api/health requires it.
 *
 * The HMAC secret comes from OPEN_RUNNER_SECRET, or is random per process —
 * in which case everyone logs in again after a restart.
 */
import crypto from "node:crypto";
import type express from "express";

const PASSWORD = process.env.OPEN_RUNNER_PASSWORD ?? "";
/**
 * Preferred: an scrypt hash from `node scripts/hash-password.mjs`, as
 * `scrypt$N$r$p$<salt b64>$<hash b64>`. A copied .env then reveals no password.
 */
const PASSWORD_HASH = parseHash(process.env.OPEN_RUNNER_PASSWORD_HASH ?? "");
const SECRET = process.env.OPEN_RUNNER_SECRET || crypto.randomBytes(32).toString("hex");
const COOKIE = "or_session";
const MAX_AGE_S = 7 * 24 * 3600;

export const authRequired = PASSWORD.length > 0 || PASSWORD_HASH !== null;
if (PASSWORD && PASSWORD_HASH) console.warn("[auth] both OPEN_RUNNER_PASSWORD and OPEN_RUNNER_PASSWORD_HASH are set; using the hash");

interface ScryptHash { N: number; r: number; p: number; salt: Buffer; hash: Buffer }
function parseHash(s: string): ScryptHash | null {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(s.trim());
  if (!m) {
    if (s.trim()) console.error("[auth] OPEN_RUNNER_PASSWORD_HASH is not in the scrypt$N$r$p$salt$hash form; ignoring it");
    return null;
  }
  return { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]), salt: Buffer.from(m[4], "base64"), hash: Buffer.from(m[5], "base64") };
}

/** Constant-time check of a login attempt against the hash or the plain password. */
function passwordOk(attempt: string): boolean {
  if (PASSWORD_HASH) {
    const { N, r, p, salt, hash } = PASSWORD_HASH;
    const got = crypto.scryptSync(attempt, salt, hash.length, { N, r, p, maxmem: 256 * 1024 * 1024 });
    return crypto.timingSafeEqual(got, hash);
  }
  return safeEqual(attempt, PASSWORD);
}

const sign = (payload: string) => crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");

function safeEqual(a: string, b: string) {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(req: express.Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function isAuthenticated(req: express.Request) {
  if (!authRequired) return true;
  const token = readCookie(req, COOKIE);
  if (!token) return false;
  const [exp, mac] = token.split(".");
  if (!exp || !mac || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(mac, sign(exp));
}

function setCookie(req: express.Request, res: express.Response, value: string, maxAge: number) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https" || process.env.COOKIE_SECURE === "1";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`,
  );
}

// Basic brute-force brake: at most 5 failed attempts per IP per 5 minutes.
// `req.ip` is the real client only if `trust proxy` is set when a reverse
// proxy sits in front (TRUST_PROXY in index.ts); otherwise every visitor
// shares the proxy's address and one bucket.
const WINDOW_MS = 5 * 60_000;
const failures = new Map<string, number[]>();
function tooManyFailures(ip: string) {
  const now = Date.now();
  for (const [k, ts] of failures) if (!ts.some((t) => now - t < WINDOW_MS)) failures.delete(k);
  const recent = (failures.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  failures.set(ip, recent);
  return recent.length >= 5;
}

export function mountAuth(app: express.Express) {
  app.get("/api/auth/me", (req, res) => {
    res.json({ required: authRequired, authenticated: isAuthenticated(req) });
  });

  app.post("/api/auth/login", (req, res) => {
    if (!authRequired) return res.json({ ok: true });
    const ip = req.ip ?? "unknown";
    if (tooManyFailures(ip)) {
      return res.status(429).json({ error: { message: "Too many attempts. Try again in a few minutes." } });
    }
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!passwordOk(password)) {
      failures.get(ip)!.push(Date.now());
      return res.status(401).json({ error: { message: "Wrong password." } });
    }
    failures.delete(ip);
    const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE_S);
    setCookie(req, res, `${exp}.${sign(exp)}`, MAX_AGE_S);
    res.json({ ok: true });
  });

  app.post("/api/auth/logout", (req, res) => {
    setCookie(req, res, "", 0);
    res.json({ ok: true });
  });

  // Gate everything else under /api.
  app.use("/api", (req, res, next) => {
    if (req.path === "/health" || isAuthenticated(req)) return next();
    res.status(401).json({ error: { message: "Not signed in." } });
  });
}
