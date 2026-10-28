import { describe, expect, it } from "vitest";
import { isChatModel, matchesQuery } from "./modelFilter";

const m = (id: string, name = id, output_modalities = ["text"]) => ({ id, name, output_modalities });

describe("isChatModel", () => {
  it("keeps chat and vision models", () => {
    expect(isChatModel(m("nim/nvidia/nemotron-3-ultra-550b-a55b", "Nemotron 3 Ultra 550B"))).toBe(true);
    expect(isChatModel(m("nim/nvidia/nemotron-3.5-super-vl-120b-a12b"))).toBe(true);
    expect(isChatModel(m("GLM-5.3"))).toBe(true);
    expect(isChatModel(m("nim/microsoft/kosmos-2"))).toBe(true);
  });

  it("hides embedders, guards, detectors and speech models", () => {
    expect(isChatModel(m("nim/nvidia/llama-3.2-nv-embedqa-1b-v1"))).toBe(false);
    expect(isChatModel(m("nim/nvidia/llama-3.1-nemoguard-8b-content-safety"))).toBe(false);
    expect(isChatModel(m("nim/meta/llama-guard-4-12b"))).toBe(false);
    expect(isChatModel(m("nim/nvidia/ai-synthetic-video-detector"))).toBe(false);
    expect(isChatModel(m("nim/google/deplot"))).toBe(false);
    expect(isChatModel(m("Whisper-Large-v3"))).toBe(false);
    expect(isChatModel(m("scx-stt"))).toBe(false);
  });

  it("hides models with no text output", () => {
    expect(isChatModel(m("some/image-model", "Image", ["image"]))).toBe(false);
  });
});

describe("matchesQuery", () => {
  it("matches name or id, ignoring case", () => {
    expect(matchesQuery(m("nim/z-ai/glm-5.3-flash", "GLM-5.3 Flash (NVIDIA)"), "glm")).toBe(true);
    expect(matchesQuery(m("nim/deepseek-ai/deepseek-v4.1-flash", "DeepSeek V4.1 Flash"), "DEEPSEEK")).toBe(true);
    expect(matchesQuery(m("GLM-5.3"), "kimi")).toBe(false);
    expect(matchesQuery(m("GLM-5.3"), "  ")).toBe(true);
  });
});
