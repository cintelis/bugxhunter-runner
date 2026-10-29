import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.OPEN_RUNNER_VAULT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bxh-prov-")), "vault.json");
process.env.OPENROUTER_MODELS = "anthropic/claude-sonnet-4.5, openai/gpt-5";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-real";
process.env.ANTHROPIC_API_KEY_FILE = "/nonexistent";
const providers = await import("./providers.js");

describe("providers", () => {
  it("routes Playground model ids to the right client", () => {
    expect(providers.clientFor("GLM-5.3")).toMatchObject({ provider: "scx", model: "GLM-5.3" });
    expect(providers.clientFor("openrouter/anthropic/claude-sonnet-4.5")).toMatchObject({ provider: "openrouter", model: "anthropic/claude-sonnet-4.5" });
  });

  it("spots uncurated NVIDIA vision models from their ids", () => {
    for (const id of ["meta/llama-3.2-11b-vision-instruct", "meta/llama-3.2-90b-vision-instruct", "microsoft/phi-3-vision-128k-instruct", "acme/model-vl-7b", "acme/model-vl"]) {
      expect(providers.looksLikeVision(id), id).toBe(true);
    }
    for (const id of ["z-ai/glm-5.3-flash", "nvidia/nemotron-3.5-lightning-30b-a3b", "acme/evolve-7b", "acme/vlad-1"]) {
      expect(providers.looksLikeVision(id), id).toBe(false);
    }
  });

  it("normalises an OpenRouter catalogue entry into the Playground's shape", () => {
    const m = providers.normaliseOpenRouter({
      id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5", context_length: 1_000_000,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      top_provider: { max_completion_tokens: 64_000 },
      pricing: { prompt: "0.000003", completion: "0.000015" },
      supported_parameters: ["temperature", "tools", "tool_choice", "response_format", "reasoning", "max_tokens"],
    });
    expect(m).toMatchObject({
      id: "openrouter/anthropic/claude-sonnet-4.5", provider: "openrouter", context_length: 1_000_000, max_output_length: 64_000,
      input_modalities: ["text", "image"], supported_features: ["tools", "json_mode", "reasoning"],
      supported_sampling_parameters: ["temperature", "max_tokens"],
    });
    expect(providers.normaliseOpenRouter({ id: "x" })).toMatchObject({ id: "openrouter/x", name: "x", supported_features: [], input_modalities: ["text"] });
  });

  it("reads OPENROUTER_MODELS as a trimmed list and builds an OpenCode provider through the proxy", async () => {
    expect(providers.OPENROUTER_MODELS).toEqual(["anthropic/claude-sonnet-4.5", "openai/gpt-5"]);
    const p = await providers.openrouterOpencodeProvider("http://127.0.0.1:8790/openrouter/v1");
    expect(p).toMatchObject({ npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:8790/openrouter/v1", apiKey: providers.PROXY_TOKEN } });
    expect(Object.keys((p as { models: object }).models)).toEqual(["anthropic/claude-sonnet-4.5", "openai/gpt-5"]);
  });

  it("scrubs keys from the environment and reports where they come from", () => {
    expect(process.env.SCX_API).toBeUndefined();
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(["vault", "file", "env", "opencode-auth", "none"]).toContain(providers.keySource("openrouter"));
  });
});

describe("isRetiredStatus", () => {
  it("treats 404 and 410 as retired, nothing else", () => {
    expect(providers.isRetiredStatus(404)).toBe(true);
    expect(providers.isRetiredStatus(410)).toBe(true); // NVIDIA end-of-life response
    for (const s of [200, 401, 403, 429, 500, 502, 504]) expect(providers.isRetiredStatus(s), String(s)).toBe(false);
  });
});

describe("anthropic provider", () => {
  it("routes anthropic/ ids to Claude, leaving OpenRouter's anthropic/ ids alone", () => {
    expect(providers.clientFor("anthropic/claude-opus-5-5")).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5" });
    expect(providers.clientFor("openrouter/anthropic/claude-sonnet-4.5")).toMatchObject({ provider: "openrouter" });
  });

  it("scrubs the key from the environment so the agent never inherits it", () => {
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY_FILE).toBeUndefined();
  });

  const claude = providers.PROVIDERS.anthropic;
  const scx = providers.PROVIDERS.scx;

  it("accepts the proxy token in x-api-key for Anthropic only", () => {
    expect(providers.proxyTokenOk(claude, { "x-api-key": "tok" }, "tok")).toBe(true);
    expect(providers.proxyTokenOk(claude, { authorization: "Bearer tok" }, "tok")).toBe(true);
    expect(providers.proxyTokenOk(claude, { "x-api-key": "nope" }, "tok")).toBe(false);
    expect(providers.proxyTokenOk(scx, { "x-api-key": "tok" }, "tok")).toBe(false);
    expect(providers.proxyTokenOk(scx, { authorization: "Bearer tok" }, "tok")).toBe(true);
  });

  it("forwards only the Messages API paths for Anthropic", () => {
    expect([...providers.proxyPaths(claude)]).toEqual(["/messages", "/messages/count_tokens", "/models"]);
    expect(providers.proxyPaths(claude).has("/chat/completions")).toBe(false);
    expect(providers.proxyPaths(scx).has("/chat/completions")).toBe(true);
  });

  it("sends the real key in Anthropic's scheme, passing on the client's version and betas", () => {
    const h = providers.upstreamHeaders(claude, { "x-api-key": "tok", "anthropic-version": "2023-06-01", "anthropic-beta": "a,b" }, "sk-ant-real");
    expect(h).toMatchObject({ "x-api-key": "sk-ant-real", "anthropic-version": "2023-06-01", "anthropic-beta": "a,b" });
    expect(h).not.toHaveProperty("Authorization");
    expect(providers.upstreamHeaders(claude, {}, "k")["anthropic-version"]).toBe("2023-06-01");
    expect(providers.upstreamHeaders(scx, {}, "sk-scx")).toMatchObject({ Authorization: "Bearer sk-scx" });
  });
});
