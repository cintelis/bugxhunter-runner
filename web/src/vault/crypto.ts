/**
 * Browser half of the key vault (format: shared/vault.d.ts). Everything here
 * is WebCrypto and symmetric: AES-256-GCM, HKDF-SHA-256, PBKDF2-SHA-256. The
 * server never sees a passphrase, a PRF output or a recovery code — only the
 * wrapped keys it stores and, after an unlock, the DEK for its memory.
 */
import type { Pbkdf2Params, PasskeyMethod, PasswordMethod, RecoveryMethod, Sealed, VaultDoc, VaultMethod } from "../../../shared/vault";

export const PBKDF2_ITERATIONS = 600_000;
/** Fixed: the PRF output is a function of (credential, salt). Change = every passkey derives a different secret. */
export const PRF_SALT = "bugxhunter-vault-prf-v1";
const HKDF_INFO = "bugxhunter-vault-kek-v1";
const VERIFIER_TEXT = "bugxhunter-vault-ok";

const enc = new TextEncoder();
const subtle = crypto.subtle;

export const b64 = {
  enc: (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...(b instanceof Uint8Array ? b : new Uint8Array(b)))),
  dec: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};
export const b64url = {
  enc: (b: ArrayBuffer | Uint8Array) => b64.enc(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s: string) => b64.dec(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)),
};
export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
// A plain ArrayBuffer view, which is what the WebCrypto typings want.
const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

async function pbkdf2(secret: string, params: Pbkdf2Params): Promise<Uint8Array> {
  const key = await subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", hash: params.hash, salt: buf(b64.dec(params.salt)), iterations: params.iterations },
    key, 256,
  );
  return new Uint8Array(bits);
}

/**
 * The passkey's KEK: HKDF over the authenticator's PRF output. One touch; the
 * authenticator's user verification is the second factor. Legacy vaults (from
 * before one-touch unlock) mixed a passphrase in as well: those methods carry
 * `passphrase` parameters and need the passphrase here.
 */
async function passkeyKek(prf: Uint8Array, m: Pick<PasskeyMethod, "passphrase" | "hkdfSalt">, passphrase?: string): Promise<CryptoKey> {
  if (prf.length !== 32) throw new Error("PRF output must be 32 bytes");
  let ikm: Uint8Array;
  if (m.passphrase) {
    if (!passphrase) throw new Error("This passkey was enrolled with a passphrase; enter it as well.");
    const pass = await pbkdf2(passphrase, m.passphrase);
    ikm = new Uint8Array(64);
    ikm.set(prf, 0);
    ikm.set(pass, 32);
    pass.fill(0);
  } else {
    ikm = new Uint8Array(prf);
  }
  const hk = await subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveKey"]);
  const kek = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buf(b64.dec(m.hkdfSalt)), info: enc.encode(HKDF_INFO) },
    hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
  ikm.fill(0);
  return kek;
}

/** A KEK from a typed secret (backup passphrase, recovery code). */
async function secretKek(secret: string, kdf: Pbkdf2Params): Promise<CryptoKey> {
  const bits = await pbkdf2(secret, kdf);
  const kek = await subtle.importKey("raw", buf(bits), "AES-GCM", false, ["encrypt", "decrypt"]);
  bits.fill(0);
  return kek;
}

export async function sealWith(key: CryptoKey, data: Uint8Array, aad: string): Promise<Sealed> {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: enc.encode(aad) }, key, buf(data));
  return { iv: b64.enc(iv), ct: b64.enc(ct) };
}

export async function openWith(key: CryptoKey, sealed: Sealed, aad: string): Promise<Uint8Array> {
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: buf(b64.dec(sealed.iv)), additionalData: enc.encode(aad) }, key, buf(b64.dec(sealed.ct)),
  );
  return new Uint8Array(pt);
}

// --- recovery codes -----------------------------------------------------------
// 128 random bits as 26 characters from an alphabet without 0/O/1/I, grouped
// for reading aloud. Normalising strips separators and case.

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateRecoveryCode(): string {
  const bytes = randomBytes(16);
  let bits = 0, acc = 0, out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(acc >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out.match(/.{1,5}/g)!.join("-");
}

export const normaliseRecoveryCode = (s: string) => s.toUpperCase().replace(/[^A-Z2-9]/g, "");

export function looksLikeRecoveryCode(s: string) {
  const n = normaliseRecoveryCode(s);
  return n.length === 26 && [...n].every((c) => ALPHABET.includes(c));
}

// --- building and unlocking ---------------------------------------------------

/** What enrolment produced: the credential, its PRF output, and its public key for sign-in. */
export interface Enrolled {
  credentialId: string;
  transports?: string[];
  prf: Uint8Array;
  publicKey: string;
  alg: number;
}

export interface BuildInput extends Enrolled {
  label: string;
  /** Optional backup passphrase: a second way in besides the passkey and the recovery code. */
  passphrase?: string;
  /** Initial sealed items, e.g. { SCX_API: "sk-..." }. */
  items: Record<string, string>;
}

const newId = (prefix: string) => `${prefix}-${b64url.enc(randomBytes(6))}`;
const pbkdf2Params = (): Pbkdf2Params => ({ name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: b64.enc(randomBytes(16)) });

/** Wrap a DEK for a passkey (at setup, or when adding a passkey later). */
export async function wrapForPasskey(dekRaw: Uint8Array, e: Enrolled, label: string): Promise<PasskeyMethod> {
  const method: PasskeyMethod = {
    type: "passkey", id: newId("pk"), label,
    credentialId: e.credentialId, transports: e.transports, publicKey: e.publicKey, alg: e.alg, signCount: 0, prfSalt: PRF_SALT,
    hkdfSalt: b64.enc(randomBytes(16)), wrapped: { iv: "", ct: "" }, createdAt: new Date().toISOString(),
  };
  method.wrapped = await sealWith(await passkeyKek(e.prf, method), dekRaw, method.id);
  return method;
}

/** Wrap a DEK for the backup passphrase. */
export async function wrapForPassword(dekRaw: Uint8Array, passphrase: string): Promise<PasswordMethod> {
  const method: PasswordMethod = {
    type: "password", id: newId("pw"), label: "Backup passphrase", kdf: pbkdf2Params(), wrapped: { iv: "", ct: "" }, createdAt: new Date().toISOString(),
  };
  method.wrapped = await sealWith(await secretKek(passphrase, method.kdf), dekRaw, method.id);
  return method;
}

/** Generate the DEK; wrap it for the passkey, the recovery code and (if given) the backup passphrase; seal the items. */
export async function buildVault(input: BuildInput): Promise<{ doc: VaultDoc; dek: string; recoveryCode: string }> {
  const dekRaw = randomBytes(32);
  const dek = await subtle.importKey("raw", buf(dekRaw), "AES-GCM", false, ["encrypt"]);
  const now = new Date().toISOString();

  const methods: VaultMethod[] = [await wrapForPasskey(dekRaw, input, input.label)];
  if (input.passphrase) methods.push(await wrapForPassword(dekRaw, input.passphrase));
  const recoveryCode = generateRecoveryCode();
  const recovery: RecoveryMethod = { type: "recovery", id: newId("rc"), label: "Recovery code", kdf: pbkdf2Params(), wrapped: { iv: "", ct: "" }, createdAt: now };
  recovery.wrapped = await sealWith(await secretKek(normaliseRecoveryCode(recoveryCode), recovery.kdf), dekRaw, recovery.id);
  methods.push(recovery);

  const items: VaultDoc["items"] = {};
  for (const [name, value] of Object.entries(input.items)) if (value) items[name] = await sealWith(dek, enc.encode(value), name);

  const doc: VaultDoc = { version: 1, createdAt: now, methods, verifier: await sealWith(dek, enc.encode(VERIFIER_TEXT), "verifier"), items };
  const dekB64 = b64.enc(dekRaw);
  dekRaw.fill(0);
  return { doc, dek: dekB64, recoveryCode };
}

/** Unwrap the DEK with a passkey's PRF output (plus the passphrase for a legacy method). Throws on a wrong factor. */
export async function unwrapWithPasskey(m: PasskeyMethod, prf: Uint8Array, passphrase?: string): Promise<string> {
  const kek = await passkeyKek(prf, m, passphrase);
  return b64.enc(await openWith(kek, m.wrapped, m.id));
}

export async function unwrapWithPassword(m: PasswordMethod, passphrase: string): Promise<string> {
  const kek = await secretKek(passphrase, m.kdf);
  return b64.enc(await openWith(kek, m.wrapped, m.id));
}

export async function unwrapWithRecovery(m: RecoveryMethod, code: string): Promise<string> {
  const kek = await secretKek(normaliseRecoveryCode(code), m.kdf);
  return b64.enc(await openWith(kek, m.wrapped, m.id));
}
