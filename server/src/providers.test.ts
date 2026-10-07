import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.OPEN_RUNNER_VAULT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bxh-prov-")), "vault.json");
process.env.OPENROUTER_MODELS = "anthropic/claude-sonnet-4.5, openai/gpt-5";
const providers = await import("./providers.js");

describe("providers", () => {
  it("routes Playground model ids to the right client", () => {
    expect(providers.clientFor("GLM-5.3")).toMatchObject({ provider: "scx", model: "GLM-5.3" });
    expect(providers.clientFor("openrouter/anthropic/claude-sonnet-4.5")).toMatchObject({ provider: "openrouter", model: "anthropic/claude-sonnet-4.5" });
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
    expect(["vault", "env", "opencode-auth", "none"]).toContain(providers.keySource("openrouter"));
  });
});
