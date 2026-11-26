import { describe, expect, it } from "vitest";
import { reasoningEffortFor } from "./types";

const reasons = { supported_features: ["tools", "reasoning"] };
const plain = { supported_features: ["tools"] };

describe("reasoningEffortFor", () => {
  it("sends the chosen effort to a model that reasons", () => {
    expect(reasoningEffortFor("medium", reasons)).toBe("medium");
    expect(reasoningEffortFor("xhigh", reasons)).toBe("xhigh");
  });

  it("sends nothing for the model default, so the model's (or the runner's) own default stands", () => {
    expect(reasoningEffortFor("", reasons)).toBeUndefined();
    expect(reasoningEffortFor(undefined, reasons)).toBeUndefined(); // a config saved before the setting existed
  });

  it("sends nothing to a model that does not reason, or a value that is not an effort", () => {
    expect(reasoningEffortFor("low", plain)).toBeUndefined();
    expect(reasoningEffortFor("low", undefined)).toBeUndefined();
    expect(reasoningEffortFor("none", reasons)).toBeUndefined();
  });
});
