import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A key file and a key in the environment both set: the file must win, and must be read on every call.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bxh-keyfile-"));
const keyFile = path.join(dir, "scx-key");
fs.writeFileSync(keyFile, "sk-scx-from-file-1\n");
process.env.OPEN_RUNNER_VAULT_FILE = path.join(dir, "vault.json");
process.env.SCX_API_FILE = keyFile;
process.env.SCX_API = "sk-scx-from-env";
const providers = await import("./providers.js");

describe("a model key from a file", () => {
  it("is preferred to a key in the environment, and its path is scrubbed from the environment", () => {
    expect(providers.keySource("scx")).toBe("file");
    expect(providers.apiKey("scx")).toBe("sk-scx-from-file-1");
    expect(process.env.SCX_API_FILE).toBeUndefined();
    expect(process.env.SCX_API).toBeUndefined();
  });

  it("is re-read on every call, so replacing the file rotates the key", () => {
    fs.writeFileSync(keyFile, "sk-scx-from-file-2");
    expect(providers.apiKey("scx")).toBe("sk-scx-from-file-2");
  });

  it("is refused, not swapped for the key in the clear, when the file is gone or empty", () => {
    fs.writeFileSync(keyFile, "  \n");
    expect(() => providers.apiKey("scx")).toThrow(/key file/);
    fs.rmSync(keyFile);
    expect(() => providers.apiKey("scx")).toThrow(/key file/);
  });
});
