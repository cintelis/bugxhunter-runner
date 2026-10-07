import { describe, expect, it } from "vitest";
import { lineDiff, patchLines, withContext } from "./diff";

describe("lineDiff", () => {
  it("marks added, removed and unchanged lines", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "x" },
      { kind: "same", text: "c" },
    ]);
  });
  it("treats empty sides as all-added or all-removed", () => {
    expect(lineDiff("", "a\nb")).toEqual([{ kind: "add", text: "a" }, { kind: "add", text: "b" }]);
    expect(lineDiff("a", "")).toEqual([{ kind: "del", text: "a" }]);
  });
});

describe("withContext", () => {
  it("keeps changed lines plus context and collapses gaps", () => {
    const lines = [...Array.from({ length: 10 }, (_, i) => ({ kind: "same" as const, text: `l${i}` })), { kind: "add" as const, text: "new" }];
    const out = withContext(lines, 2);
    expect(out[0]).toBeNull();
    expect(out.slice(1)).toEqual([
      { kind: "same", text: "l8" }, { kind: "same", text: "l9" }, { kind: "add", text: "new" },
    ]);
  });
});

describe("patchLines", () => {
  it("drops file headers, turns hunk headers into gaps and strips markers", () => {
    const patch = [
      "--- a/x.ts", "+++ b/x.ts",
      "@@ -1,3 +1,3 @@", " keep", "-old", "+new", "\\ No newline at end of file",
      "@@ -10,2 +10,2 @@", " tail", "",
    ].join("\n");
    expect(patchLines(patch)).toEqual([
      { kind: "same", text: "keep" }, { kind: "del", text: "old" }, { kind: "add", text: "new" },
      null,
      { kind: "same", text: "tail" },
    ]);
  });
});
