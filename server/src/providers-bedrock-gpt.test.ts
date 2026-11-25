import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A runner that offers GLM 5.3 and a hosted GPT model on Bedrock.
process.env.OPEN_RUNNER_VAULT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bxh-bedrock-gpt-")), "vault.json");
process.env.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE";
process.env.AWS_SECRET_ACCESS_KEY = "not-a-real-secret";
process.env.BEDROCK_REGION = "ap-southeast-2";
process.env.BEDROCK_MODELS = "global.zai.glm-5.3,global.openai.gpt-6.2-astra";
delete process.env.BEDROCK_REASONING_EFFORT;
delete process.env.AWS_BEARER_TOKEN_BEDROCK;
delete process.env.AWS_PROFILE;
delete process.env.AWS_ROLE_ARN;
const providers = await import("./providers.js");
const bedrock = await import("./bedrock.js");

describe("a hosted GPT model on Bedrock", () => {
  it("is in the Playground's list, reading images", () => {
    const astra = providers.bedrockModel("global.openai.gpt-6.2-astra");
    expect(astra.input_modalities).toEqual(["text", "image"]);
    expect(astra.supported_features).not.toContain("tools");
  });

  it("is kept from the agent, which cannot work without tools", () => {
    expect(bedrock.agentModels()).toEqual(["global.zai.glm-5.3"]);
    const p = providers.bedrockOpencodeProvider("http://127.0.0.1:8790/bedrock/v1")!;
    expect(Object.keys(p.models as object)).toEqual(["global.zai.glm-5.3"]);
  });

  it("may still be named through the proxy, where Bedrock's own refusal of tools shows", () => {
    const call = Buffer.from(JSON.stringify({ model: "global.openai.gpt-6.2-astra", max_tokens: 10, tools: [{}] }));
    expect(providers.proxyRefusal(providers.PROVIDERS.bedrock, call)).toBeNull();
    const sent = JSON.parse(providers.proxyBody(providers.PROVIDERS.bedrock, call).toString("utf8"));
    expect(sent).toEqual({ model: "global.openai.gpt-6.2-astra", max_completion_tokens: 10, tools: [{}] });
  });

  it("treats a GPT model the runner has no entry for the same way", () => {
    expect(bedrock.isOpenAiGpt("global.openai.gpt-6.2-sol")).toBe(true);
    expect(providers.bedrockModel("global.openai.gpt-6.2-sol").supported_sampling_parameters).toEqual(["max_tokens"]);
  });
});
