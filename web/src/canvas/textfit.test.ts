import { describe, expect, it } from "vitest";
import { FONT_TITLE, fitText, textWidth } from "./textfit";

describe("fitText", () => {
  it("keeps text that fits", () => {
    expect(fitText("Web server", 200, FONT_TITLE)).toBe("Web server");
  });

  it("cuts long text with an ellipsis so it fits the width", () => {
    const long = "HARDWARE ROOT OF TRUST - RESIDUAL / e-FUSE + immutable ROM";
    const out = fitText(long, 150, FONT_TITLE);
    expect(out.endsWith("…")).toBe(true);
    expect(textWidth(out, FONT_TITLE)).toBeLessThanOrEqual(150);
    expect(long.startsWith(out.slice(0, -1).trimEnd())).toBe(true);
  });

  it("handles no room and characters outside the basic plane", () => {
    expect(fitText("anything", 0, FONT_TITLE)).toBe("");
    expect(fitText("🔐🔐🔐🔐🔐🔐🔐🔐🔐🔐🔐🔐🔐🔐🔐🔐🔐🔐", 40, FONT_TITLE)).not.toMatch(/\uD83D$/);
  });
});
