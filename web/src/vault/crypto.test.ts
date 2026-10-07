import { describe, expect, it } from "vitest";
import { b64, b64url, buildVault, generateRecoveryCode, looksLikeRecoveryCode, normaliseRecoveryCode, unwrapWithPasskey, unwrapWithPassword, unwrapWithRecovery } from "./crypto";
import type { PasskeyMethod, PasswordMethod, RecoveryMethod } from "../../../shared/vault";

// Node's global WebCrypto, btoa and atob stand in for the browser's.

describe("recovery codes", () => {
  it("are 26 characters from the safe alphabet, grouped by 5", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^([A-HJ-NP-Z2-9]{5}-){5}[A-HJ-NP-Z2-9]$/);
    expect(looksLikeRecoveryCode(code)).toBe(true);
    expect(looksLikeRecoveryCode(code.toLowerCase().replace(/-/g, " "))).toBe(true);
    expect(normaliseRecoveryCode(" ab-cd ")).toBe("ABCD");
    expect(looksLikeRecoveryCode("short")).toBe(false);
  });
});

describe("base64", () => {
  it("round-trips, including url-safe", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    expect(b64.dec(b64.enc(bytes))).toEqual(bytes);
    expect(b64url.dec(b64url.enc(bytes))).toEqual(bytes);
    expect(b64url.enc(bytes)).not.toMatch(/[+/=]/);
  });
});

const enrolled = { credentialId: "AQID", transports: ["internal"], publicKey: "AAAA", alg: -7, label: "test" };

describe("buildVault / unwrap", () => {
  it("wraps the same DEK for the passkey (PRF only), the backup passphrase and the recovery code", async () => {
    const prf = new Uint8Array(32).fill(42);
    const { doc, dek, recoveryCode } = await buildVault({ ...enrolled, prf, passphrase: "correct horse battery", items: { SCX_API: "sk-x" } });
    expect(doc.methods.map((m) => m.type)).toEqual(["passkey", "password", "recovery"]);
    expect(Object.keys(doc.items)).toEqual(["SCX_API"]);
    expect(JSON.stringify(doc)).not.toContain("sk-x");
    expect(JSON.stringify(doc)).not.toContain(dek);
    const [pk, pw, rc] = doc.methods as [PasskeyMethod, PasswordMethod, RecoveryMethod];
    expect(pk.passphrase).toBeUndefined();
    expect(await unwrapWithPasskey(pk, prf)).toBe(dek); // one touch
    expect(await unwrapWithPassword(pw, "correct horse battery")).toBe(dek);
    expect(await unwrapWithRecovery(rc, recoveryCode.toLowerCase())).toBe(dek);
  }, 60_000);

  it("fails with a wrong PRF output, passphrase or code; skips the passphrase method when none was set", async () => {
    const prf = new Uint8Array(32).fill(1);
    const { doc } = await buildVault({ ...enrolled, prf, passphrase: "right one", items: {} });
    const [pk, pw, rc] = doc.methods as [PasskeyMethod, PasswordMethod, RecoveryMethod];
    await expect(unwrapWithPasskey(pk, new Uint8Array(32).fill(2))).rejects.toThrow();
    await expect(unwrapWithPassword(pw, "wrong")).rejects.toThrow();
    await expect(unwrapWithRecovery(rc, generateRecoveryCode())).rejects.toThrow();
    const bare = await buildVault({ ...enrolled, prf, items: {} });
    expect(bare.doc.methods.map((m) => m.type)).toEqual(["passkey", "recovery"]);
  }, 60_000);
});
