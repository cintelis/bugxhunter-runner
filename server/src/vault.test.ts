import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the vault at a scratch file before the module reads its path.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bxh-vault-"));
process.env.OPEN_RUNNER_VAULT_FILE = path.join(dir, "vault.json");
const vault = await import("./vault.js");

const subtle = webcrypto.subtle;
const b64 = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64");
const enc = new TextEncoder();

/**
 * The browser's side of the protocol, done with WebCrypto exactly as
 * web/src/vault/crypto.ts does it, so this test pins the two halves to the
 * same byte layout: AES-256-GCM with the tag appended, AAD = item name /
 * method id, KEK = HKDF(PRF || PBKDF2(passphrase)).
 */
async function browserSetup(passphrase: string, prf: Uint8Array) {
  const dekRaw = webcrypto.getRandomValues(new Uint8Array(32));
  const dek = await subtle.importKey("raw", dekRaw, "AES-GCM", false, ["encrypt"]);
  const sealWith = async (key: CryptoKey, text: string, aad: string) => {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(text));
    return { iv: b64(iv), ct: b64(ct) };
  };
  // passkey method: KEK = HKDF(prf || pbkdf2(passphrase))
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const hkdfSalt = webcrypto.getRandomValues(new Uint8Array(16));
  const pass = await subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const passBits = new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 1000 }, pass, 256));
  const ikm = new Uint8Array(64); ikm.set(prf, 0); ikm.set(passBits, 32);
  const hk = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  const kek = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: hkdfSalt, info: enc.encode("bugxhunter-vault-kek-v1") }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const wrapIv = webcrypto.getRandomValues(new Uint8Array(12));
  const wrapped = await subtle.encrypt({ name: "AES-GCM", iv: wrapIv, additionalData: enc.encode("pk-1") }, kek, dekRaw);
  const doc = {
    version: 1 as const,
    createdAt: new Date().toISOString(),
    methods: [{
      type: "passkey" as const, id: "pk-1", label: "test", credentialId: "AAAA", prfSalt: "bugxhunter-vault-prf-v1",
      passphrase: { name: "PBKDF2" as const, hash: "SHA-256" as const, iterations: 1000, salt: b64(salt) },
      hkdfSalt: b64(hkdfSalt), wrapped: { iv: b64(wrapIv), ct: b64(wrapped) }, createdAt: new Date().toISOString(),
    }],
    verifier: await sealWith(dek, "bugxhunter-vault-ok", "verifier"),
    items: { SCX_API: await sealWith(dek, "sk-scx-test-123", "SCX_API") },
  };
  return { doc, dekB64: b64(dekRaw) };
}

beforeEach(() => { try { fs.unlinkSync(process.env.OPEN_RUNNER_VAULT_FILE!); } catch { /* none */ } vault.sealVault(); });
afterEach(() => vault.sealVault());

describe("vault", () => {
  it("starts uninitialised and sealed", () => {
    expect(vault.isInitialised()).toBe(false);
    expect(vault.isUnsealed()).toBe(false);
    expect(vault.getItem("SCX_API")).toBeUndefined();
  });

  it("accepts a browser-built document and decrypts its items with the DEK", async () => {
    const { doc, dekB64 } = await browserSetup("correct horse", new Uint8Array(32).fill(7));
    vault.initialise(doc, dekB64);
    expect(vault.isUnsealed()).toBe(true);
    expect(vault.getItem("SCX_API")).toBe("sk-scx-test-123");
    const onDisk = JSON.parse(fs.readFileSync(process.env.OPEN_RUNNER_VAULT_FILE!, "utf8"));
    expect(JSON.stringify(onDisk)).not.toContain("sk-scx-test-123");
    expect(JSON.stringify(onDisk)).not.toContain(dekB64);
  });

  it("refuses a DEK that does not open the verifier, and a second initialise", async () => {
    const { doc, dekB64 } = await browserSetup("pw", new Uint8Array(32).fill(1));
    expect(() => vault.initialise(doc, Buffer.alloc(32, 9).toString("base64"))).toThrow(/verifier/);
    vault.initialise(doc, dekB64);
    expect(() => vault.initialise(doc, dekB64)).toThrow(/already exists/);
  });

  it("seals, refuses items while sealed, and unseals with the right key only", async () => {
    const { doc, dekB64 } = await browserSetup("pw", new Uint8Array(32).fill(2));
    vault.initialise(doc, dekB64);
    vault.sealVault();
    expect(() => vault.getItem("SCX_API")).toThrow(/sealed/);
    expect(() => vault.unseal(Buffer.alloc(32, 3).toString("base64"))).toThrow(/does not open/);
    vault.unseal(dekB64);
    expect(vault.getItem("SCX_API")).toBe("sk-scx-test-123");
  });

  it("stores new items sealed with AAD bound to the name", async () => {
    const { doc, dekB64 } = await browserSetup("pw", new Uint8Array(32).fill(4));
    vault.initialise(doc, dekB64);
    vault.setItem("TARGET_TOKEN", "t0k3n");
    expect(vault.getItem("TARGET_TOKEN")).toBe("t0k3n");
    expect(() => vault.setItem("bad name", "x")).toThrow(/UPPER_SNAKE/);
    // swapping ciphertexts between names must fail the tag check
    const onDisk = JSON.parse(fs.readFileSync(process.env.OPEN_RUNNER_VAULT_FILE!, "utf8"));
    expect(() => vault.open(Buffer.from(dekB64, "base64"), onDisk.items.TARGET_TOKEN, "SCX_API")).toThrow();
    vault.deleteItem("TARGET_TOKEN");
    expect(vault.getItem("TARGET_TOKEN")).toBeUndefined();
  });

  it("seal/open round-trip in Node matches the WebCrypto layout", () => {
    const key = Buffer.alloc(32, 5);
    const s = vault.seal(key, "hello", "x");
    expect(Buffer.from(s.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(s.ct, "base64")).toHaveLength(5 + 16);
    expect(vault.open(key, s, "x").toString()).toBe("hello");
    expect(() => vault.open(key, s, "y")).toThrow();
  });
});
