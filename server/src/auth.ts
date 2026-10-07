/**
 * Sign-in with the vault's passkey. No passwords.
 *
 * Until a vault with a sign-in-capable passkey exists, the API is open: the
 * server listens on localhost only and refuses foreign Host headers, so that
 * is the same trust boundary as a local tool. Once a passkey is enrolled, every
 * /api route except /api/auth/* and /api/health needs a session cookie, issued
 * after one of:
 *
 *  - a WebAuthn assertion verified here against the public key captured at
 *    enrolment (single-use challenge, allowed origin, rpId hash, user presence
 *    and verification flags, signature, monotonic counter when the
 *    authenticator keeps one); or
 *  - proof of the vault's data key (the recovery path: the browser unwrapped it
 *    with the recovery code), which also unseals the vault.
 *
 * The cookie is `<expiry>.<hmac>` under OPEN_RUNNER_SECRET, or a random
 * per-process secret, in which case a restart signs everyone out.
 */
import crypto from "node:crypto";
import type express from "express";
import type { AuthChallenge, AuthMe, PasskeyAssertion } from "../../shared/vault.js";
import * as vault from "./vault.js";
import { audit } from "./audit.js";

const SECRET = process.env.OPEN_RUNNER_SECRET || crypto.randomBytes(32).toString("hex");
const COOKIE = "or_session";
const MAX_AGE_S = 7 * 24 * 3600;
const CHALLENGE_TTL_MS = 2 * 60_000;

export const authRequired = () => vault.loginCredentials().length > 0;

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

export function isAuthenticated(req: express.Request) {
  if (!authRequired()) return true;
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

/** Start a session for this browser (after a verified assertion, a recovery proof, or creating the vault). */
export function issueSession(req: express.Request, res: express.Response) {
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE_S);
  setCookie(req, res, `${exp}.${sign(exp)}`, MAX_AGE_S);
}

// --- challenges: single use, short-lived, bounded -------------------------------

const challenges = new Map<string, number>();
export function issueChallenge(): string {
  const now = Date.now();
  for (const [c, exp] of challenges) if (exp < now) challenges.delete(c);
  if (challenges.size > 1000) challenges.clear();
  const c = crypto.randomBytes(32).toString("base64url");
  challenges.set(c, now + CHALLENGE_TTL_MS);
  return c;
}
function consumeChallenge(c: string): boolean {
  const exp = challenges.get(c);
  challenges.delete(c);
  return exp !== undefined && exp >= Date.now();
}

// --- WebAuthn assertion verification --------------------------------------------

const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest();

/** Hostname of an origin, without an IPv6's brackets, lower-cased. */
function hostOf(origin: string): string {
  const u = new URL(origin);
  return u.hostname.toLowerCase();
}

export class AssertionError extends Error {
  constructor(message: string) { super(message); this.name = "AssertionError"; }
}

/**
 * Verify a WebAuthn assertion against the enrolled passkeys. Returns the
 * method that signed. Throws AssertionError with a reason safe to show.
 */
export function verifyAssertion(a: PasskeyAssertion, allowedHosts: Set<string>): { methodId: string; credentialId: string } {
  const cred = vault.loginCredentials().find((m) => m.credentialId === a.credentialId);
  if (!cred) throw new AssertionError("Unknown passkey.");

  // clientDataJSON: type, our challenge, an origin we serve.
  let cd: { type?: string; challenge?: string; origin?: string };
  const cdBytes = Buffer.from(a.clientDataJSON, "base64url");
  try { cd = JSON.parse(cdBytes.toString("utf8")); } catch { throw new AssertionError("Malformed client data."); }
  if (cd.type !== "webauthn.get") throw new AssertionError("Not a sign-in assertion.");
  if (!cd.challenge || !consumeChallenge(cd.challenge)) throw new AssertionError("Challenge expired or already used. Try again.");
  let host: string;
  try { host = hostOf(cd.origin ?? ""); } catch { throw new AssertionError("Malformed origin."); }
  if (!allowedHosts.has(host)) throw new AssertionError(`Origin ${cd.origin} is not allowed.`);

  // authenticatorData: rpIdHash, flags (UP, UV), counter.
  const authData = Buffer.from(a.authenticatorData, "base64url");
  if (authData.length < 37) throw new AssertionError("Malformed authenticator data.");
  if (!crypto.timingSafeEqual(authData.subarray(0, 32), sha256(Buffer.from(host, "utf8")))) {
    throw new AssertionError("The passkey was made for a different site name.");
  }
  const flags = authData[32];
  if (!(flags & 0x01)) throw new AssertionError("User presence not confirmed.");
  if (!(flags & 0x04)) throw new AssertionError("User verification (PIN, biometric) is required.");
  const counter = authData.readUInt32BE(33);
  if (counter > 0 && (cred.signCount ?? 0) > 0 && counter <= (cred.signCount ?? 0)) {
    audit("auth.counter.regressed", { credentialId: a.credentialId, seen: cred.signCount, got: counter });
    throw new AssertionError("Signature counter went backwards — a cloned authenticator? Sign in with another passkey or the recovery code.");
  }

  // signature over authenticatorData || SHA-256(clientDataJSON), with the enrolled key.
  const signed = Buffer.concat([authData, sha256(cdBytes)]);
  const sig = Buffer.from(a.signature, "base64url");
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({ key: Buffer.from(cred.publicKey!, "base64"), format: "der", type: "spki" });
  } catch {
    throw new AssertionError("The enrolled public key is unreadable.");
  }
  let ok = false;
  try {
    switch (cred.alg) {
      case -7: ok = crypto.verify("sha256", signed, { key, dsaEncoding: "der" }, sig); break;   // ES256
      case -8: ok = crypto.verify(null, signed, key, sig); break;                                 // Ed25519
      case -257: ok = crypto.verify("sha256", signed, key, sig); break;                           // RS256
      default: throw new AssertionError(`Unsupported algorithm ${cred.alg}.`);
    }
  } catch (e) {
    if (e instanceof AssertionError) throw e;
    ok = false;
  }
  if (!ok) throw new AssertionError("Signature did not verify.");
  if (counter > 0) vault.recordSignCount(cred.id, counter);
  return { methodId: cred.id, credentialId: cred.credentialId };
}

// --- routes ------------------------------------------------------------------------

export function mountAuth(app: express.Express, allowedHosts: Set<string>) {
  app.get("/api/auth/me", (req, res) => {
    const me: AuthMe = { required: authRequired(), authenticated: isAuthenticated(req) };
    res.json(me);
  });

  // The sign-in screen needs the public method parameters (to unlock the
  // vault in the same touch, and for the recovery path). Public by design.
  app.get("/api/auth/methods", (_req, res) => res.json({ methods: vault.publicMethods() }));

  app.post("/api/auth/challenge", (req, res) => {
    const creds = vault.loginCredentials();
    if (!creds.length) { issueSession(req, res); return res.json({ open: true }); }
    const body: AuthChallenge = {
      challenge: issueChallenge(),
      rpId: hostOf(`http://${(req.headers.host ?? "localhost").toLowerCase()}`),
      allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: c.transports })),
    };
    res.json(body);
  });

  app.post("/api/auth/passkey", (req, res) => {
    const a = req.body as PasskeyAssertion;
    if (!a?.credentialId || !a.clientDataJSON || !a.authenticatorData || !a.signature) {
      return res.status(400).json({ error: { message: "assertion fields required" } });
    }
    try {
      const { credentialId } = verifyAssertion(a, allowedHosts);
      issueSession(req, res);
      audit("auth.signin", { method: "passkey", credentialId });
      res.json({ ok: true });
    } catch (e) {
      audit("auth.signin.failed", { method: "passkey", reason: (e as Error).message });
      res.status(401).json({ error: { message: e instanceof AssertionError ? e.message : "Sign-in failed." } });
    }
  });

  // Lost passkey: proving possession of the vault key (unwrapped in the
  // browser with the recovery code) signs in and unseals in one step.
  app.post("/api/auth/recover", (req, res) => {
    if (typeof req.body?.dek !== "string") return res.status(400).json({ error: { message: "dek required" } });
    try {
      vault.unseal(req.body.dek); // throws 401 if it doesn't open the verifier
      issueSession(req, res);
      audit("auth.signin", { method: "recovery" });
      res.json({ ok: true });
    } catch {
      audit("auth.signin.failed", { method: "recovery" });
      res.status(401).json({ error: { message: "That key does not open the vault." } });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    setCookie(req, res, "", 0);
    res.json({ ok: true });
  });

  // Gate everything else under /api.
  app.use("/api", (req, res, next) => {
    if (req.path === "/health" || isAuthenticated(req)) return next();
    // The header is how the browser tells our 401 apart from an upstream one
    // (e.g. SCX rejecting a key), which must not bounce it to the sign-in screen.
    res.setHeader("WWW-Authenticate", "BXH-Passkey");
    res.status(401).json({ error: { message: "Not signed in.", code: "unauthenticated" } });
  });
}
