import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The agent container's entrypoint builds OpenCode's inline config with a node script held in
// a single-quoted shell string. v0.11.0 shipped with an apostrophe in a comment inside it: the
// shell ended the string there, node ran only the lines before, and every inline setting
// (OpenRouter models, Bedrock models, recon role models) was dropped without an error.
// These tests run the real script through sh, as the container does.

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docker/agent-entrypoint.sh");
const source = fs.readFileSync(script, "utf8");

/** The `if ... fi` block that builds the config, which needs neither git nor /workspace. */
const block = source.slice(source.indexOf('if [ -n "${OPENROUTER_MODELS'), source.lastIndexOf("exec "));

function inlineConfig(env: Record<string, string>): Record<string, any> | null {
  const out = execFileSync("sh", ["-c", `${block}\nprintf '%s' "\${OPENCODE_CONFIG_CONTENT:-}"`], {
    env: { PATH: process.env.PATH ?? "", SCX_PROXY_TOKEN: "proxy-token", ...env },
    encoding: "utf8",
  });
  return out ? JSON.parse(out) : null;
}

describe("the agent entrypoint's inline config", () => {
  it("keeps the node script inside one shell string", () => {
    const body = block.slice(block.indexOf("node -e '") + "node -e '".length, block.lastIndexOf("')"));
    expect(body).not.toContain("'");
  });

  it("sets nothing when nothing is asked for", () => {
    expect(inlineConfig({})).toBeNull();
  });

  it("turns BEDROCK_MODELS into a provider through the runner's proxy", () => {
    const cfg = inlineConfig({ BEDROCK_MODELS: "global.zai.glm-5.3, zai.glm-5" })!;
    expect(cfg.provider.bedrock).toMatchObject({
      npm: "@ai-sdk/openai-compatible", name: "Amazon Bedrock",
      options: { baseURL: "http://runner:8790/bedrock/v1", apiKey: "proxy-token" },
    });
    expect(cfg.provider.bedrock.models).toEqual({
      "global.zai.glm-5.3": { name: "GLM 5.3 (Bedrock)", limit: { context: 1_000_000, output: 128_000 } },
      "zai.glm-5": { name: "zai.glm-5", limit: { context: 128_000, output: 16_000 } },
    });
  });

  it("leaves the hosted GPT models out of the agent's Bedrock provider", () => {
    const cfg = inlineConfig({ BEDROCK_MODELS: "global.zai.glm-5.3,global.openai.gpt-6.2-astra,openai.gpt-oss-120b-1:0" })!;
    expect(Object.keys(cfg.provider.bedrock.models)).toEqual(["global.zai.glm-5.3", "openai.gpt-oss-120b-1:0"]);
    expect(inlineConfig({ BEDROCK_MODELS: "global.openai.gpt-6.2-astra" })).toEqual({});
  });

  it("turns OPENROUTER_MODELS into a provider, alongside Bedrock", () => {
    const cfg = inlineConfig({ OPENROUTER_MODELS: "openai/gpt-6.1-sol", BEDROCK_MODELS: "global.zai.glm-5.3" })!;
    expect(Object.keys(cfg.provider).sort()).toEqual(["bedrock", "openrouter"]);
    expect(cfg.provider.openrouter.options.baseURL).toBe("http://runner:8790/openrouter/v1");
    expect(Object.keys(cfg.provider.openrouter.models)).toEqual(["openai/gpt-6.1-sol"]);
  });

  it("puts a recon role on the model it is given", () => {
    const cfg = inlineConfig({ RECON_VERIFY_MODEL: "bedrock/global.zai.glm-5.3", RECON_TRIAGE_MODEL: " anthropic/claude-haiku-5-5 " })!;
    expect(cfg.agent).toEqual({ "recon-verify": { model: "bedrock/global.zai.glm-5.3" }, "recon-triage": { model: "anthropic/claude-haiku-5-5" } });
  });
});
