import { describe, expect, it } from "vitest";
import { cached, readSettings, signRequest, type AwsCredentials } from "./bedrock.js";

const KEYS = { AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "not-a-real-secret" };

describe("Bedrock settings", () => {
  it("has no AWS credentials unless something names them", () => {
    const s = readSettings({});
    expect(s).toMatchObject({ mode: "none", region: "us-east-1", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1" });
    expect(s.credentials).toBeUndefined();
    // An instance or default profile is used only when asked for, never by surprise.
    expect(readSettings({ BEDROCK_AUTH: "aws" }).mode).toBe("chain");
    expect(readSettings({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/x" }).mode).toBe("chain");
  });

  it("takes the region from BEDROCK_REGION, then AWS's own variables, and builds the endpoint from it", () => {
    expect(readSettings({ AWS_DEFAULT_REGION: "eu-west-1" }).region).toBe("eu-west-1");
    expect(readSettings({ AWS_REGION: "us-west-2", AWS_DEFAULT_REGION: "eu-west-1" }).region).toBe("us-west-2");
    const s = readSettings({ BEDROCK_REGION: "ap-southeast-2", AWS_REGION: "us-west-2" });
    expect(s.baseUrl).toBe("https://bedrock-runtime.ap-southeast-2.amazonaws.com/openai/v1");
    expect(readSettings({ BEDROCK_REGION: "us-gov-west-1" }).region).toBe("us-gov-west-1");
  });

  it("refuses a region that is not a region name (it becomes part of a host name)", () => {
    for (const bad of ["evil.example/x", "ap-southeast-2.attacker.test", "AP-SOUTHEAST-2", "sydney"]) {
      expect(() => readSettings({ BEDROCK_REGION: bad }), bad).toThrow(/not an AWS region/);
    }
  });

  it("picks an OIDC role first, then a profile, then keys", () => {
    const oidc = { AWS_ROLE_ARN: "arn:aws:iam::111122223333:role/runner", AWS_WEB_IDENTITY_TOKEN_FILE: "/run/token" };
    expect(readSettings({ ...oidc, AWS_PROFILE: "dev", ...KEYS })).toMatchObject({ mode: "web-identity", describe: "OIDC web identity, role arn:aws:iam::111122223333:role/runner" });
    expect(readSettings({ AWS_PROFILE: "dev", ...KEYS })).toMatchObject({ mode: "profile", describe: 'AWS profile "dev"' });
    expect(readSettings({ BEDROCK_AWS_PROFILE: "models", AWS_PROFILE: "dev" }).describe).toBe('AWS profile "models"');
    expect(readSettings({ ...KEYS })).toMatchObject({ mode: "static", describe: "long-lived access keys in the environment" });
    expect(readSettings({ ...KEYS, AWS_SESSION_TOKEN: "t" }).describe).toBe("temporary access keys in the environment");
    // Half an OIDC setup is not one.
    expect(readSettings({ AWS_ROLE_ARN: oidc.AWS_ROLE_ARN }).mode).toBe("none");
  });

  it("removes what it read from the environment, so the agent's shell does not inherit it", () => {
    const env: NodeJS.ProcessEnv = {
      ...KEYS, AWS_SESSION_TOKEN: "t", AWS_PROFILE: "dev", BEDROCK_AWS_PROFILE: "models",
      AWS_ROLE_ARN: "arn:aws:iam::111122223333:role/runner", AWS_WEB_IDENTITY_TOKEN_FILE: "/run/token", AWS_ROLE_SESSION_NAME: "s",
      PATH: "/usr/bin",
    };
    readSettings(env);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("never puts a secret in the description", async () => {
    const s = readSettings({ ...KEYS, AWS_SESSION_TOKEN: "session-secret" });
    expect(s.describe).not.toMatch(/AKIDEXAMPLE|not-a-real-secret|session-secret/);
    expect(await s.credentials!()).toEqual({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "not-a-real-secret", sessionToken: "session-secret" });
  });
});

describe("SigV4 signing for Bedrock", () => {
  const creds: AwsCredentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "not-a-real-secret" };
  const at = new Date("2026-11-25T03:04:05Z");
  const request = {
    method: "post", url: "https://bedrock-runtime.ap-southeast-2.amazonaws.com/openai/v1/chat/completions",
    headers: { "Content-Type": "application/json", Accept: "*/*" }, body: '{"model":"global.zai.glm-5.3"}',
  };

  it("signs for the bedrock service in the region, over the headers it is given", async () => {
    const h = await signRequest(request, "ap-southeast-2", creds, at);
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261125\/ap-southeast-2\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(h["x-amz-date"]).toBe("20261125T030405Z");
    expect(h["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(h["Content-Type"]).toBe("application/json");
    expect(h).not.toHaveProperty("host"); // fetch sets it
    expect(h).not.toHaveProperty("x-amz-security-token");
    expect(JSON.stringify(h)).not.toContain("not-a-real-secret");
  });

  it("is deterministic, and covers the body and the URL", async () => {
    const sig = async (r: typeof request) => (await signRequest(r, "ap-southeast-2", creds, at)).authorization;
    expect(await sig(request)).toBe(await sig({ ...request }));
    expect(await sig({ ...request, body: '{"model":"other"}' })).not.toBe(await sig(request));
    expect(await sig({ ...request, url: request.url.replace("chat/completions", "responses") })).not.toBe(await sig(request));
    // Bytes and the same text sign alike: the proxy signs the agent's raw body.
    const bytes = await signRequest({ ...request, body: new TextEncoder().encode(request.body) }, "ap-southeast-2", creds, at);
    expect(bytes.authorization).toBe(await sig(request));
  });

  it("sends the session token of temporary credentials", async () => {
    const h = await signRequest(request, "ap-southeast-2", { ...creds, sessionToken: "session-token" }, at);
    expect(h["x-amz-security-token"]).toBe("session-token");
  });
});

describe("the credential cache", () => {
  it("asks once for concurrent callers and again shortly before expiry", async () => {
    let now = 1_000_000, calls = 0;
    const source = cached(async () => {
      calls += 1;
      return { accessKeyId: `K${calls}`, secretAccessKey: "s", expiration: new Date(now + 60 * 60_000) };
    }, () => now);
    const [a, b] = await Promise.all([source(), source()]);
    expect([a.accessKeyId, b.accessKeyId, calls]).toEqual(["K1", "K1", 1]);
    now += 50 * 60_000;
    expect((await source()).accessKeyId).toBe("K1");
    now += 6 * 60_000; // inside the last five minutes
    expect((await source()).accessKeyId).toBe("K2");
  });

  it("re-reads credentials that have no expiry, and does not keep a failure", async () => {
    let now = 0, calls = 0, fail = true;
    const source = cached(async () => {
      calls += 1;
      if (fail) throw new Error("Token is expired");
      return { accessKeyId: `K${calls}`, secretAccessKey: "s" };
    }, () => now);
    await expect(source()).rejects.toThrow(/expired/);
    fail = false; // the operator signed in again
    expect((await source()).accessKeyId).toBe("K2");
    now += 4 * 60_000;
    expect((await source()).accessKeyId).toBe("K2");
    now += 2 * 60_000;
    expect((await source()).accessKeyId).toBe("K3");
  });
});
