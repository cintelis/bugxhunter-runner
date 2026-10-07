import { beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the vault at a scratch file before the modules read its path.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bxh-auth-"));
process.env.OPEN_RUNNER_VAULT_FILE = path.join(dir, "vault.json");
const vault = await import("./vault.js");
const auth = await import("./auth.js");

const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest();
const b64url = (b: Buffer) => b.toString("base64url");

/** An ES256 passkey as the browser would have enrolled it, inside a vault. */
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const CRED_ID = b64url(crypto.randomBytes(16));
const DEK = crypto.randomBytes(32);

beforeAll(() => {
  const sealed = (text: string, aad: string) => vault.seal(DEK, text, aad);
  vault.initialise({
    version: 1, createdAt: new Date().toISOString(),
    methods: [{
      type: "passkey", id: "pk-test", label: "test", credentialId: CRED_ID, prfSalt: "bugxhunter-vault-prf-v1",
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"), alg: -7, signCount: 0,
      passphrase: { name: "PBKDF2", hash: "SHA-256", iterations: 1000, salt: "AAAA" }, hkdfSalt: "AAAA",
      wrapped: { iv: "AAAAAAAAAAAAAAAA", ct: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, createdAt: new Date().toISOString(),
    }],
    verifier: sealed("bugxhunter-vault-ok", "verifier"), items: {},
  }, DEK.toString("base64"));
});

/** Build an assertion the way an authenticator + browser would. */
function assertion(opts: { challenge: string; origin?: string; rpId?: string; flags?: number; counter?: number; tamper?: boolean; credentialId?: string }) {
  const cd = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: opts.challenge, origin: opts.origin ?? "http://localhost:8790" }));
  const authData = Buffer.concat([
    sha256(Buffer.from(opts.rpId ?? "localhost")),
    Buffer.from([opts.flags ?? 0x05]),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(opts.counter ?? 0); return b; })(),
  ]);
  let sig = crypto.sign("sha256", Buffer.concat([authData, sha256(cd)]), { key: privateKey, dsaEncoding: "der" });
  if (opts.tamper) sig = Buffer.from(sig.map((x, i) => (i === 10 ? x ^ 0xff : x)));
  return { credentialId: opts.credentialId ?? CRED_ID, clientDataJSON: b64url(cd), authenticatorData: b64url(authData), signature: b64url(sig) };
}

const HOSTS = new Set(["localhost", "127.0.0.1"]);

describe("passkey sign-in", () => {
  it("is required once a login-capable passkey exists", () => {
    expect(auth.authRequired()).toBe(true);
    expect(vault.loginCredentials().map((c) => c.credentialId)).toEqual([CRED_ID]);
  });

  it("accepts a valid assertion for a fresh challenge", () => {
    const c = auth.issueChallenge();
    expect(auth.verifyAssertion(assertion({ challenge: c }), HOSTS)).toEqual({ methodId: "pk-test", credentialId: CRED_ID });
  });

  it("refuses a replayed, unknown or expired challenge", () => {
    const c = auth.issueChallenge();
    auth.verifyAssertion(assertion({ challenge: c }), HOSTS);
    expect(() => auth.verifyAssertion(assertion({ challenge: c }), HOSTS)).toThrow(/already used/);
    expect(() => auth.verifyAssertion(assertion({ challenge: b64url(crypto.randomBytes(32)) }), HOSTS)).toThrow(/Challenge/);
  });

  it("refuses a wrong origin, rpId, missing user verification, bad signature, unknown passkey", () => {
    expect(() => auth.verifyAssertion(assertion({ challenge: auth.issueChallenge(), origin: "https://evil.example" }), HOSTS)).toThrow(/not allowed/);
    expect(() => auth.verifyAssertion(assertion({ challenge: auth.issueChallenge(), rpId: "evil.example" }), HOSTS)).toThrow(/different site/);
    expect(() => auth.verifyAssertion(assertion({ challenge: auth.issueChallenge(), flags: 0x01 }), HOSTS)).toThrow(/verification/);
    expect(() => auth.verifyAssertion(assertion({ challenge: auth.issueChallenge(), tamper: true }), HOSTS)).toThrow(/Signature did not verify/);
    expect(() => auth.verifyAssertion(assertion({ challenge: auth.issueChallenge(), credentialId: "nope" }), HOSTS)).toThrow(/Unknown passkey/);
  });

  it("tracks the signature counter and refuses a regression", () => {
    auth.verifyAssertion(assertion({ challenge: auth.issueChallenge(), counter: 5 }), HOSTS);
    expect(vault.loginCredentials()[0].signCount).toBe(5);
    expect(() => auth.verifyAssertion(assertion({ challenge: auth.issueChallenge(), counter: 5 }), HOSTS)).toThrow(/counter went backwards/);
    auth.verifyAssertion(assertion({ challenge: auth.issueChallenge(), counter: 6 }), HOSTS);
  });

  it("the recovery path needs the real vault key", () => {
    vault.sealVault();
    expect(() => vault.unseal(crypto.randomBytes(32).toString("base64"))).toThrow(/does not open/);
    vault.unseal(DEK.toString("base64"));
    expect(vault.isUnsealed()).toBe(true);
  });

  it("passkeys can be added only with the held key, and the last one can't be removed", () => {
    const extra = { ...vault.loginCredentials()[0], id: "pk-2", credentialId: b64url(crypto.randomBytes(16)) };
    expect(() => vault.addMethod(extra, crypto.randomBytes(32).toString("base64"))).toThrow(/holding the vault key/);
    vault.addMethod(extra, DEK.toString("base64"));
    expect(vault.loginCredentials()).toHaveLength(2);
    vault.removeMethod("pk-test");
    expect(() => vault.removeMethod("pk-2")).toThrow(/last one/);
    expect(() => vault.destroy(crypto.randomBytes(32).toString("base64"))).toThrow(/holding the vault key/);
    vault.destroy(DEK.toString("base64"));
    expect(auth.authRequired()).toBe(false);
    expect(vault.isInitialised()).toBe(false);
  });
});
