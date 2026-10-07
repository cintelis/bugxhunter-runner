/**
 * Browser half of the key vault (format: shared/vault.d.ts). Everything here
 * is WebCrypto and symmetric: AES-256-GCM, HKDF-SHA-256, PBKDF2-SHA-256. The
 * server never sees a passphrase, a PRF output or a recovery code — only the
 * wrapped keys it stores and, after an unlock, the DEK for its memory.
 */
import type { Pbkdf2Params, PasskeyMethod, RecoveryMethod, Sealed, VaultDoc } from "../../../shared/vault";

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

/** Both factors go into the KEK: the authenticator's PRF output and the passphrase. */
async function passkeyKek(prf: Uint8Array, passphrase: string, m: Pick<PasskeyMethod, "passphrase" | "hkdfSalt">): Promise<CryptoKey> {
  if (prf.length !== 32) throw new Error("PRF output must be 32 bytes");
  const pass = await pbkdf2(passphrase, m.passphrase);
  const ikm = new Uint8Array(64);
  ikm.set(prf, 0);
  ikm.set(pass, 32);
  const hk = await subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveKey"]);
  const kek = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buf(b64.dec(m.hkdfSalt)), info: enc.encode(HKDF_INFO) },
    hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
  ikm.fill(0); pass.fill(0);
  return kek;
}

async function recoveryKek(code: string, kdf: Pbkdf2Params): Promise<CryptoKey> {
  const bits = await pbkdf2(normaliseRecoveryCode(code), kdf);
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

export interface BuildInput {
  passphrase: string;
  prf: Uint8Array;
  credentialId: string;
  transports?: string[];
  label: string;
  /** Initial sealed items, e.g. { SCX_API: "sk-..." }. */
  items: Record<string, string>;
}

/** Generate the DEK, wrap it for a passkey+passphrase method and a recovery code, seal the items. */
export async function buildVault(input: BuildInput): Promise<{ doc: VaultDoc; dek: string; recoveryCode: string }> {
  const dekRaw = randomBytes(32);
  const dek = await subtle.importKey("raw", buf(dekRaw), "AES-GCM", false, ["encrypt"]);
  const now = new Date().toISOString();

  const passkey: PasskeyMethod = {
    type: "passkey", id: `pk-${b64url.enc(randomBytes(6))}`, label: input.label,
    credentialId: input.credentialId, transports: input.transports, prfSalt: PRF_SALT,
    passphrase: { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: b64.enc(randomBytes(16)) },
    hkdfSalt: b64.enc(randomBytes(16)), wrapped: { iv: "", ct: "" }, createdAt: now,
  };
  passkey.wrapped = await sealWith(await passkeyKek(input.prf, input.passphrase, passkey), dekRaw, passkey.id);

  const recoveryCode = generateRecoveryCode();
  const recovery: RecoveryMethod = {
    type: "recovery", id: `rc-${b64url.enc(randomBytes(6))}`, label: "Recovery code",
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: b64.enc(randomBytes(16)) },
    wrapped: { iv: "", ct: "" }, createdAt: now,
  };
  recovery.wrapped = await sealWith(await recoveryKek(recoveryCode, recovery.kdf), dekRaw, recovery.id);

  const items: VaultDoc["items"] = {};
  for (const [name, value] of Object.entries(input.items)) if (value) items[name] = await sealWith(dek, enc.encode(value), name);

  const doc: VaultDoc = {
    version: 1, createdAt: now, methods: [passkey, recovery],
    verifier: await sealWith(dek, enc.encode(VERIFIER_TEXT), "verifier"), items,
  };
  const dekB64 = b64.enc(dekRaw);
  dekRaw.fill(0);
  return { doc, dek: dekB64, recoveryCode };
}

/** Unwrap the DEK with a passkey's PRF output and the passphrase. Throws on a wrong factor. */
export async function unwrapWithPasskey(m: PasskeyMethod, prf: Uint8Array, passphrase: string): Promise<string> {
  const kek = await passkeyKek(prf, passphrase, m);
  return b64.enc(await openWith(kek, m.wrapped, m.id));
}

export async function unwrapWithRecovery(m: RecoveryMethod, code: string): Promise<string> {
  const kek = await recoveryKek(code, m.kdf);
  return b64.enc(await openWith(kek, m.wrapped, m.id));
}
