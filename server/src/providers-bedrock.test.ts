import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Bedrock on AWS credentials: no key anywhere, the runner signs each call.
process.env.OPEN_RUNNER_VAULT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bxh-bedrock-")), "vault.json");
process.env.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE";
process.env.AWS_SECRET_ACCESS_KEY = "not-a-real-secret";
process.env.AWS_SESSION_TOKEN = "session-token";
process.env.BEDROCK_REGION = "ap-southeast-2";
process.env.BEDROCK_MODELS = "global.zai.glm-5.3, arn:aws:bedrock:ap-southeast-2:111122223333:application-inference-profile/abc123";
delete process.env.AWS_BEARER_TOKEN_BEDROCK;
delete process.env.AWS_PROFILE;
delete process.env.AWS_ROLE_ARN;
const providers = await import("./providers.js");

const ARN = "arn:aws:bedrock:ap-southeast-2:111122223333:application-inference-profile/abc123";
const bedrock = providers.PROVIDERS.bedrock;

describe("Amazon Bedrock on AWS credentials", () => {
  it("counts as configured, and its credentials have left the environment", () => {
    expect(providers.keySource("bedrock")).toBe("aws");
    expect(providers.configured("bedrock")).toBe(true);
    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(process.env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(() => providers.apiKey("bedrock")).toThrow(/signed with AWS credentials/);
  });

  it("points at the region's OpenAI-compatible endpoint and proxies only chat completions", () => {
    expect(bedrock.baseUrl).toBe("https://bedrock-runtime.ap-southeast-2.amazonaws.com/openai/v1");
    expect([...providers.proxyPaths(bedrock)]).toEqual(["/chat/completions"]);
  });

  it("routes bedrock/ ids, inference-profile ARNs included", () => {
    expect(providers.clientFor("bedrock/global.zai.glm-5.3")).toMatchObject({ provider: "bedrock", model: "global.zai.glm-5.3" });
    expect(providers.clientFor(`bedrock/${ARN}`)).toMatchObject({ provider: "bedrock", model: ARN });
  });

  it("describes its models for the Playground", () => {
    expect(providers.bedrockModel("global.zai.glm-5.3")).toMatchObject({
      id: "bedrock/global.zai.glm-5.3", name: "GLM 5.3 (Bedrock)", provider: "bedrock",
      context_length: 1_000_000, max_output_length: 128_000, input_modalities: ["text"], supported_features: ["tools", "reasoning"],
    });
    expect(providers.bedrockModel(ARN)).toMatchObject({ id: `bedrock/${ARN}`, name: ARN, context_length: null, supported_features: ["tools"] });
  });

  it("gives the agent a provider that goes through the proxy with the proxy token only", () => {
    const p = providers.bedrockOpencodeProvider("http://127.0.0.1:8790/bedrock/v1")!;
    expect(p).toMatchObject({ npm: "@ai-sdk/openai-compatible", name: "Amazon Bedrock", options: { baseURL: "http://127.0.0.1:8790/bedrock/v1", apiKey: providers.PROXY_TOKEN } });
    expect(p.models).toMatchObject({
      "global.zai.glm-5.3": { name: "GLM 5.3 (Bedrock)", limit: { context: 1_000_000, output: 128_000 } },
      [ARN]: { limit: { context: 128_000, output: 16_000 } },
    });
    expect(JSON.stringify(p)).not.toMatch(/AKIDEXAMPLE|not-a-real-secret|session-token/);
  });

  it("signs what the proxy sends upstream, and passes neither the proxy token nor a bearer key on", async () => {
    const url = `${bedrock.baseUrl}/chat/completions`;
    const body = new TextEncoder().encode('{"model":"global.zai.glm-5.3","messages":[]}');
    const h = await providers.proxyHeaders(bedrock, { authorization: `Bearer ${providers.PROXY_TOKEN}`, "content-type": "application/json" }, { method: "POST", url, body });
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/ap-southeast-2\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
    expect(h["x-amz-security-token"]).toBe("session-token");
    expect(h["Content-Type"]).toBe("application/json");
    expect(h).not.toHaveProperty("Authorization");
    expect(JSON.stringify(h)).not.toContain(providers.PROXY_TOKEN);
  });

  it("lists its models without asking SCX, when SCX has no key", async () => {
    const asked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      asked.push(String(input));
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const models = await providers.listModels();
      expect(models.map((m) => m.id)).toContain("bedrock/global.zai.glm-5.3");
      // A provider is asked exactly when it has a key (a developer's machine may hold an SCX one).
      expect(asked.some((url) => url.startsWith(providers.PROVIDERS.scx.baseUrl))).toBe(providers.configured("scx"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("still injects a bearer key for the other providers", async () => {
    await expect(providers.authHeaders("openrouter", { method: "POST", url: "https://openrouter.ai/api/v1/chat/completions", headers: {} })).rejects.toThrow(/No OpenRouter key/);
  });
});
