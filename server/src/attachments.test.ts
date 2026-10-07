import { describe, expect, it } from "vitest";
import { safeName } from "./attachments.js";

describe("safeName", () => {
  it("keeps only the base name and ordinary characters", () => {
    expect(safeName("report (final).pdf")).toBe("report (final).pdf");
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("C:\\Users\\me\\notes.txt")).toBe("notes.txt");
    expect(safeName("weird<>:\"|?*name.txt")).toBe("weird_name.txt");
  });

  it("never produces a hidden or empty name", () => {
    expect(safeName(".env")).toBe("env");
    expect(safeName("...")).toBe("file");
    expect(safeName("")).toBe("file");
  });

  it("caps the length", () => {
    expect(safeName("x".repeat(500) + ".txt")).toHaveLength(120);
  });
});
