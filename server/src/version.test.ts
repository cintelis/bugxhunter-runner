import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION, readVersion } from "./version.js";

describe("version", () => {
  it("reads the root package.json", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
  it("says unknown when the file is missing or has no version", () => {
    expect(readVersion(path.join(os.tmpdir(), "no-such-dir", "package.json"))).toBe("unknown");
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ver-")), "package.json");
    fs.writeFileSync(f, "{}");
    expect(readVersion(f)).toBe("unknown");
  });
});
