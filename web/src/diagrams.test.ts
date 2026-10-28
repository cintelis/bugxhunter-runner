import { describe, expect, it } from "vitest";
import { diagramFileName, fixRequest, splitDiagrams } from "./diagrams";

describe("splitDiagrams", () => {
  it("keeps plain markdown as one part", () => {
    expect(splitDiagrams("Hello\n\n```python\nx = 1\n```")).toEqual([{ type: "md", text: "Hello\n\n```python\nx = 1\n```" }]);
  });

  it("pulls drawio blocks out in order", () => {
    const parts = splitDiagrams("Intro\n```drawio\ntitle: A\nnodes: []\n```\nBetween\n~~~drawgen\ntitle: B\n~~~\nEnd");
    expect(parts).toEqual([
      { type: "md", text: "Intro" },
      { type: "drawio", spec: "title: A\nnodes: []", closed: true },
      { type: "md", text: "Between" },
      { type: "drawio", spec: "title: B", closed: true },
      { type: "md", text: "End" },
    ]);
  });

  it("marks a block that is still streaming as open", () => {
    expect(splitDiagrams("Here:\n```drawio\ntitle: A\nnodes:")).toEqual([
      { type: "md", text: "Here:" },
      { type: "drawio", spec: "title: A\nnodes:", closed: false },
    ]);
  });

  it("needs a closing fence at least as long as the opening one", () => {
    const parts = splitDiagrams("````drawio\ntitle: A\n```\nstill spec\n````");
    expect(parts).toEqual([{ type: "drawio", spec: "title: A\n```\nstill spec", closed: true }]);
  });
});

describe("fixRequest", () => {
  it("lists a spec error line by line", () => {
    const m = fixRequest("spec.title: required\nspec.nodes[0].kind: 'x' is not one of [...]", []);
    expect(m).toContain("- spec.title: required");
    expect(m).toContain("```drawio");
  });
  it("lists checker issues", () => {
    expect(fixRequest(null, [{ severity: "warning", code: "overlap", cell: "a", message: "overlaps b" }])).toContain("- warning overlap a: overlaps b");
  });
});

it("makes file names from titles", () => {
  expect(diagramFileName("Order flow: v2!")).toBe("order-flow-v2");
  expect(diagramFileName("***")).toBe("diagram");
});
