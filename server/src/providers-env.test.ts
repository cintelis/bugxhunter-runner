import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// docker-compose passes `${ANTHROPIC_MODELS:-}`, so an unset variable arrives as "" (and a
// hand-edited .env can leave blanks). Empty must mean "use the defaults", not "no models":
// an empty Claude list hid every Claude model from the Runner's picker in v0.9.4.
process.env.OPEN_RUNNER_VAULT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bxh-provenv-")), "vault.json");
process.env.ANTHROPIC_MODELS = "";
process.env.NVIDIA_MODELS = "  ";
const providers = await import("./providers.js");

describe("model lists from an empty environment variable", () => {
  it("fall back to the defaults", () => {
    expect(providers.ANTHROPIC_MODELS).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(providers.NVIDIA_MODELS.length).toBeGreaterThan(0);
  });
});
