import { describe, expect, it } from "vitest";
import { buildContextBlock, chunkText } from "./rag.js";

describe("chunkText", () => {
  it("returns the whole text as one chunk when it fits", () => {
    expect(chunkText("short text")).toEqual(["short text"]);
    expect(chunkText("   ")).toEqual([]);
  });

  it("splits long text into overlapping chunks that cover everything", () => {
    const para = "Sentence one is here. Sentence two follows it. ";
    const text = Array.from({ length: 60 }, (_, i) => `${i} ${para}`).join("\n");
    const chunks = chunkText(text, 400, 50);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(400);
    // Every chunk's start appears in the source, and the last chunk ends the text.
    for (const c of chunks) expect(text).toContain(c.slice(0, 40));
    expect(text.trimEnd().endsWith(chunks[chunks.length - 1].slice(-20))).toBe(true);
  });

  it("prefers to break on paragraph boundaries", () => {
    const text = `${"a".repeat(300)}\n\n${"b".repeat(300)}\n\n${"c".repeat(300)}`;
    const chunks = chunkText(text, 650, 0);
    expect(chunks[0]).toBe("a".repeat(300) + "\n\n" + "b".repeat(300));
  });
});

describe("buildContextBlock", () => {
  it("is empty without chunks and numbers sources otherwise", () => {
    expect(buildContextBlock([])).toBe("");
    const block = buildContextBlock([{ text: "alpha", score: 0.9, doc: "Doc A" }, { text: "beta", score: 0.8, doc: "Doc B" }]);
    expect(block).toContain("[1] (source: Doc A)\nalpha");
    expect(block).toContain("[2] (source: Doc B)\nbeta");
  });
});
