import { beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Bedrock on AWS credentials, with a vault: the credentials live outside the vault, but a
// locked vault must still mean no model calls.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bxh-bedrock-vault-"));
process.env.OPEN_RUNNER_VAULT_FILE = path.join(dir, "vault.json");
process.env.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE";
process.env.AWS_SECRET_ACCESS_KEY = "not-a-real-secret";
process.env.BEDROCK_REGION = "ap-southeast-2";
delete process.env.AWS_BEARER_TOKEN_BEDROCK;
delete process.env.AWS_PROFILE;
delete process.env.AWS_ROLE_ARN;
const vault = await import("./vault.js");
const bedrock = await import("./bedrock.js");
const providers = await import("./providers.js");

const dek = crypto.randomBytes(32);
function setUpVault() {
  const now = new Date().toISOString();
  vault.initialise({
    version: 1,
    createdAt: now,
    methods: [{
      type: "passkey", id: "pk-1", label: "test", credentialId: "AAAA", prfSalt: "s", hkdfSalt: "s",
      wrapped: { iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" }, createdAt: now,
    }],
    verifier: vault.seal(dek, "bugxhunter-vault-ok", "verifier"),
    items: {},
  } as never, dek.toString("base64"));
}

const call = { method: "POST", url: `${providers.PROVIDERS.bedrock.baseUrl}/chat/completions`, headers: { "Content-Type": "application/json" }, body: "{}" };
const signs = async () => (await providers.authHeaders("bedrock", call)).authorization;

beforeEach(() => {
  vault.sealVault();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});

describe("Bedrock signing and the vault", () => {
  it("signs freely when there is no vault (an unattended runner)", async () => {
    expect(vault.isInitialised()).toBe(false);
    expect(await signs()).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("refuses to sign while the vault is sealed, for the Playground and the agent's proxy alike", async () => {
    setUpVault();
    expect(await signs()).toMatch(/^AWS4-HMAC-SHA256 /);
    vault.sealVault();
    await expect(signs()).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/vault is sealed/) });
    await expect(providers.proxyHeaders(providers.PROVIDERS.bedrock, { "content-type": "application/json" }, { method: "POST", url: call.url, body: new Uint8Array() }))
      .rejects.toMatchObject({ status: 503 });
    // Still configured: the models stay listed, and the error says what to do.
    expect(providers.keySource("bedrock")).toBe("aws");
  });

  it("signs again once the vault is unlocked", async () => {
    setUpVault();
    vault.sealVault();
    await expect(signs()).rejects.toMatchObject({ status: 503 });
    vault.unseal(dek.toString("base64"));
    expect(await signs()).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("tells listeners when the vault is sealed (the hook that drops the AWS credentials in memory)", async () => {
    const held = bedrock.cached(async () => ({ accessKeyId: "K", secretAccessKey: "s" }));
    let forgotten = 0;
    vault.onSealed(() => { forgotten += 1; held.forget(); });
    setUpVault();
    vault.sealVault();
    expect(forgotten).toBeGreaterThan(0);
  });

  it("counts a signed call as activity, so the vault does not auto-lock mid-session", async () => {
    setUpVault();
    const before = vault.sealsAt();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await signs();
    if (before !== null) expect(vault.sealsAt()!).toBeGreaterThan(before);
  });
});
