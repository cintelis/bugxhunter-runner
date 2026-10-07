/**
 * Server half of the key vault (see shared/vault.d.ts for the format).
 *
 * The file holds ciphertext only. The DEK arrives from the browser after the
 * user unlocks (passkey + passphrase, or recovery code), is checked against
 * the verifier, and lives in memory until sealed or the process exits. Items
 * are decrypted on demand and never written anywhere in the clear.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PasskeyMethod, PublicMethod, Sealed, VaultDoc, VaultMethod, VaultStatus } from "../../shared/vault.js";
import { audit } from "./audit.js";
import { httpError } from "./opencode.js";

export const VAULT_FILE =
  process.env.OPEN_RUNNER_VAULT_FILE ?? path.join(os.homedir(), ".config", "bugxhunter", "vault.json");

const VERIFIER_TEXT = "bugxhunter-vault-ok";
const TAG_BYTES = 16;

/**
 * Auto-lock: the vault re-seals after this long without activity (a model
 * call, or any non-read API request). 0 disables it.
 */
export const IDLE_MS = Math.max(0, Number(process.env.OPEN_RUNNER_VAULT_IDLE_MINUTES ?? 120)) * 60_000;

let dek: Buffer | null = null;
let lastUse = 0;

// The file is tiny and read rarely (per model call at most), so it is read
// fresh each time rather than cached: a vault deleted or replaced on disk is
// noticed at once.
function load(): VaultDoc | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(VAULT_FILE, "utf8")) as VaultDoc;
    if (parsed?.version !== 1 || !parsed.verifier || !Array.isArray(parsed.methods)) {
      throw new Error("not a v1 vault");
    }
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[vault] cannot read ${VAULT_FILE}:`, (e as Error).message);
    return null;
  }
}

function save(next: VaultDoc) {
  fs.mkdirSync(path.dirname(VAULT_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${VAULT_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, VAULT_FILE);
}

/** Note activity, which postpones the auto-lock. */
export function touch() {
  if (dek) lastUse = Date.now();
}

/** When the auto-lock will fire (ms since epoch), or null if sealed / disabled. */
export function sealsAt(): number | null {
  return dek && IDLE_MS > 0 ? lastUse + IDLE_MS : null;
}

const idleTimer = setInterval(() => {
  if (dek && IDLE_MS > 0 && Date.now() - lastUse >= IDLE_MS) sealVault("idle");
}, 30_000);
idleTimer.unref(); // never keeps the process alive on its own

// --- AES-256-GCM in the WebCrypto layout: iv (12 bytes), ct || tag ----------

export function seal(key: Buffer, plaintext: Buffer | string, aad: string): Sealed {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext), c.final(), c.getAuthTag()]);
  return { iv: iv.toString("base64"), ct: ct.toString("base64") };
}

export function open(key: Buffer, sealed: Sealed, aad: string): Buffer {
  const iv = Buffer.from(sealed.iv, "base64");
  const data = Buffer.from(sealed.ct, "base64");
  if (iv.length !== 12 || data.length < TAG_BYTES) throw new Error("malformed sealed value");
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(data.subarray(data.length - TAG_BYTES));
  return Buffer.concat([d.update(data.subarray(0, data.length - TAG_BYTES)), d.final()]);
}

/** True if `key` opens this vault's verifier. */
export function verifies(vault: VaultDoc, key: Buffer): boolean {
  try {
    return open(key, vault.verifier, "verifier").toString("utf8") === VERIFIER_TEXT;
  } catch {
    return false;
  }
}

// --- state ------------------------------------------------------------------

export const isInitialised = () => load() !== null;
export const isUnsealed = () => dek !== null;

/**
 * The public half of every method. Everything the browser needs to derive a
 * KEK (salts, wrapped DEKs) is public by design: without the factors it is
 * random bytes. Never the credential public key's sign counter or anything
 * from memory.
 */
export function publicMethods(): PublicMethod[] {
  return (load()?.methods ?? []).map((m) => {
    if (m.type !== "passkey") return m;
    const { publicKey, signCount: _c, ...rest } = m;
    return { ...rest, canLogin: Boolean(publicKey && m.alg !== undefined) };
  });
}

export function status(keySource: VaultStatus["keySource"]): VaultStatus {
  const v = load();
  return {
    initialised: v !== null,
    unsealed: dek !== null,
    methods: publicMethods(),
    items: Object.keys(v?.items ?? {}),
    keySource,
    idleMinutes: IDLE_MS / 60_000,
    sealsAt: sealsAt(),
  };
}

// --- sign-in support -------------------------------------------------------------

/** Passkeys that can sign in (enrolled with their public key). */
export function loginCredentials(): PasskeyMethod[] {
  return (load()?.methods ?? []).filter((m): m is PasskeyMethod => m.type === "passkey" && !!m.publicKey && m.alg !== undefined);
}

export function recordSignCount(methodId: string, count: number) {
  const v = load();
  if (!v) return;
  save({ ...v, methods: v.methods.map((m) => (m.id === methodId && m.type === "passkey" ? { ...m, signCount: count } : m)) });
}

/** True if this is the key currently in memory (so a client proving it holds the DEK may change methods). */
export function dekMatches(dekB64: string): boolean {
  const key = Buffer.from(dekB64, "base64");
  return dek !== null && key.length === 32 && crypto.timingSafeEqual(key, dek);
}

/**
 * Add an unlock method: a passkey, or the (single) backup passphrase, which
 * replaces an existing one. The caller must hold the current DEK, since the
 * method must wrap it.
 */
export function addMethod(method: VaultMethod, dekB64: string) {
  const v = load();
  if (!v) throw httpError(404, "No vault yet.");
  if (!dek) throw httpError(503, "The vault is sealed. Unlock it first.");
  if (!dekMatches(dekB64)) throw httpError(403, "Only a client holding the vault key can add a method.");
  validateMethod(method);
  if (method.type === "recovery") throw httpError(400, "The recovery code is fixed at setup.");
  if (v.methods.some((m) => m.id === method.id || (m.type === "passkey" && method.type === "passkey" && m.credentialId === method.credentialId))) {
    throw httpError(409, "That passkey is already enrolled.");
  }
  const kept = method.type === "password" ? v.methods.filter((m) => m.type !== "password") : v.methods;
  save({ ...v, methods: [...kept, method] });
  audit("vault.method.added", { type: method.type, id: method.id, label: method.label });
}

/** Delete the vault file and forget the key: the owner (proving the key) starting over. */
export function destroy(dekB64: string) {
  if (!load()) throw httpError(404, "No vault to delete.");
  if (!dekMatches(dekB64)) throw httpError(403, "Only a client holding the vault key can delete it. Lost it? Run `npm run vault:reset` on the server.");
  sealVault("user");
  fs.rmSync(VAULT_FILE, { force: true });
  audit("vault.destroyed", { file: VAULT_FILE });
}

/** Remove a passkey or the backup passphrase. The recovery code can't be removed, and the last passkey can't either. */
export function removeMethod(id: string) {
  const v = load();
  if (!v) throw httpError(404, "No vault yet.");
  const m = v.methods.find((x) => x.id === id);
  if (!m) return;
  if (m.type === "recovery") throw httpError(400, "The recovery code can't be removed.");
  if (m.type === "passkey" && v.methods.filter((x) => x.type === "passkey").length <= 1) {
    throw httpError(400, "Add another passkey before removing the last one.");
  }
  save({ ...v, methods: v.methods.filter((x) => x.id !== id) });
  audit("vault.method.removed", { id, type: m.type, label: m.label });
}

/**
 * Create the vault from a document the browser built (it generated the DEK,
 * wrapped it for each method, and sealed the verifier and initial items).
 * Refused if one exists: a vault is replaced by deleting the file on purpose.
 */
export function initialise(next: VaultDoc, dekB64: string) {
  if (load()) throw httpError(409, "A vault already exists. Delete it on the server to start over.");
  if (next?.version !== 1 || !next.methods?.length || !next.verifier) throw httpError(400, "Malformed vault document.");
  const key = Buffer.from(dekB64, "base64");
  if (key.length !== 32) throw httpError(400, "The key must be 32 bytes.");
  if (!verifies(next, key)) throw httpError(400, "The key does not open the vault's verifier.");
  for (const [name, sealed] of Object.entries(next.items ?? {})) {
    try { open(key, sealed, name); } catch { throw httpError(400, `Item "${name}" does not decrypt with the key.`); }
  }
  for (const m of next.methods) validateMethod(m);
  save({ ...next, items: next.items ?? {} });
  dek = key;
  lastUse = Date.now();
  audit("vault.initialised", { file: VAULT_FILE, methods: next.methods.map((m) => m.type), items: Object.keys(next.items ?? {}) });
}

function validateMethod(m: VaultMethod) {
  if (!m?.id || !m.wrapped?.iv || !m.wrapped?.ct) throw httpError(400, "Malformed unlock method.");
  if (m.type === "passkey") {
    if (!m.credentialId || !m.prfSalt || !m.hkdfSalt) throw httpError(400, "Malformed passkey method.");
  } else if (m.type === "password" || m.type === "recovery") {
    if (m.kdf?.name !== "PBKDF2") throw httpError(400, `Malformed ${m.type} method.`);
  } else {
    throw httpError(400, "Unknown unlock method.");
  }
}

/** The browser unwrapped the DEK; keep it if it opens the verifier. */
export function unseal(dekB64: string) {
  const v = load();
  if (!v) throw httpError(404, "No vault yet.");
  const key = Buffer.from(dekB64, "base64");
  if (key.length !== 32 || !verifies(v, key)) {
    audit("vault.unseal.failed", {});
    throw httpError(401, "That key does not open the vault.");
  }
  dek = key;
  lastUse = Date.now();
  audit("vault.unsealed", {});
}

export function sealVault(reason: "user" | "idle" = "user") {
  const was = dek !== null;
  if (dek) dek.fill(0);
  dek = null;
  if (was) audit("vault.sealed", { reason });
}

/** Plaintext of one item, or undefined if absent. Throws if sealed. Counts as activity. */
export function getItem(name: string): string | undefined {
  const v = load();
  if (!v) return undefined;
  if (!dek) throw httpError(503, "The vault is sealed (locked). Unlock it in the sidebar.");
  touch();
  const s = v.items[name];
  return s ? open(dek, s, name).toString("utf8") : undefined;
}

/** Store (or replace) an item. Only while unsealed, so the file never holds anything in the clear. */
export function setItem(name: string, value: string) {
  const v = load();
  if (!v) throw httpError(404, "No vault yet.");
  if (!dek) throw httpError(503, "The vault is sealed. Unlock it first.");
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw httpError(400, "Item names are UPPER_SNAKE_CASE.");
  if (!value) throw httpError(400, "Empty value.");
  save({ ...v, items: { ...v.items, [name]: seal(dek, value, name) } });
  audit("vault.item.set", { name });
}

export function deleteItem(name: string) {
  const v = load();
  if (!v) throw httpError(404, "No vault yet.");
  if (!(name in v.items)) return;
  const items = { ...v.items };
  delete items[name];
  save({ ...v, items });
  audit("vault.item.deleted", { name });
}
