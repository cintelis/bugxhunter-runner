import { describe, expect, it } from "vitest";
import { newToolId, stripToolIds, withToolIds } from "./tools";
import type { ToolDef } from "./types";

const tool = (name: string, id?: string): ToolDef => ({ type: "function", function: { name }, ...(id ? { id } : {}) });

describe("tool ids", () => {
  it("are unique", () => {
    expect(new Set(Array.from({ length: 50 }, newToolId)).size).toBe(50);
  });
  it("are added only where missing and stripped for the wire", () => {
    const tools = withToolIds([tool("a", "keep"), tool("b")]);
    expect(tools[0].id).toBe("keep");
    expect(tools[1].id).toMatch(/^tool_/);
    expect(stripToolIds(tools)).toEqual([{ type: "function", function: { name: "a" } }, { type: "function", function: { name: "b" } }]);
  });
});
