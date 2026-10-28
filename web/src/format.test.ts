import { describe, expect, it } from "vitest";
import { formatBytes, formatTiming, formatTokens } from "./format";

describe("formatTiming", () => {
  it("reports first token, throughput over the generation window, and total", () => {
    expect(formatTiming({ ttft: 1200, total: 3200 }, 100)).toBe("1.2s to first token · 50 tok/s · 3.2s total");
  });
  it("keeps a slow cold start out of the rate and rounds long times", () => {
    expect(formatTiming({ ttft: 25_000, total: 27_000 }, 200)).toBe("25s to first token · 100 tok/s · 27s total");
  });
  it("uses the whole turn for reasoning models (their thinking precedes the first token)", () => {
    expect(formatTiming({ ttft: 21_000, total: 22_000 }, 1828, 1200)).toBe("21s to first token · 83 tok/s · 22s total");
  });
  it("omits what it doesn't know", () => {
    expect(formatTiming({ total: 800 })).toBe("0.8s total");
  });
});

describe("formatBytes", () => {
  it("picks a unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});

describe("formatTokens", () => {
  it("abbreviates thousands and millions", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1500)).toBe("2k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });
});
