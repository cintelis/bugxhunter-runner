import { describe, expect, it } from "vitest";
import { parseModelId, query, toUiEvent, toUiMessages } from "./opencode.js";

describe("parseModelId", () => {
  it("splits provider/model at the first slash", () => {
    expect(parseModelId("scx/GLM-5.3")).toEqual({ providerID: "scx", modelID: "GLM-5.3" });
    expect(parseModelId("a/b/c")).toEqual({ providerID: "a", modelID: "b/c" });
  });
  it("returns undefined for empty or unqualified ids", () => {
    expect(parseModelId(undefined)).toBeUndefined();
    expect(parseModelId("GLM-5.3")).toBeUndefined();
  });
});

describe("query", () => {
  it("builds a query string and skips undefined values", () => {
    expect(query({ directory: "/w s", roots: true, limit: 100, x: undefined })).toBe("?directory=%2Fw+s&roots=true&limit=100");
    expect(query({})).toBe("");
  });
});

describe("toUiEvent", () => {
  it("maps text, reasoning and tool parts", () => {
    expect(toUiEvent({ type: "message.part.updated", properties: { part: { type: "text", id: "p1", messageID: "m1", text: "hi" } } }))
      .toEqual({ kind: "text", messageID: "m1", partID: "p1", text: "hi" });
    expect(toUiEvent({ type: "message.part.updated", properties: { part: { type: "reasoning", id: "p2", messageID: "m1", text: "hmm" } } }))
      .toEqual({ kind: "reasoning", messageID: "m1", partID: "p2", text: "hmm" });
    const tool = toUiEvent({
      type: "message.part.updated",
      properties: { part: { type: "tool", messageID: "m1", callID: "c1", tool: "bash", state: { status: "completed", title: "ls", input: { command: "ls" }, output: "x".repeat(30000) } } },
    });
    expect(tool).toMatchObject({ kind: "tool", messageID: "m1", callID: "c1", tool: "bash", status: "completed", title: "ls" });
    expect((tool as { output: string }).output).toHaveLength(20000);
  });

  it("accepts both permission event shapes", () => {
    const flat = toUiEvent({ type: "permission.asked", properties: { id: "perm1", sessionID: "s1", type: "bash", title: "rm -rf", pattern: "rm *" } });
    const nested = toUiEvent({ type: "permission.asked", properties: { permission: { id: "perm1", sessionID: "s1", permission: "bash", title: "rm -rf", patterns: ["rm *"], tool: { callID: "c9" } } } });
    expect(flat).toEqual({ kind: "permission", sessionID: "s1", permissionID: "perm1", permType: "bash", title: "rm -rf", pattern: "rm *", callID: undefined });
    expect(nested).toEqual({ kind: "permission", sessionID: "s1", permissionID: "perm1", permType: "bash", title: "rm -rf", pattern: ["rm *"], callID: "c9" });
  });

  it("maps questions, idle, errors and ignores the rest", () => {
    expect(toUiEvent({ type: "question.asked", properties: { id: "q1", sessionID: "s1", questions: [], tool: { callID: "c1" } } }))
      .toEqual({ kind: "question", sessionID: "s1", requestID: "q1", questions: [], callID: "c1" });
    expect(toUiEvent({ type: "question.replied", properties: { requestID: "q1" } })).toEqual({ kind: "question-closed", requestID: "q1" });
    expect(toUiEvent({ type: "session.idle", properties: { sessionID: "s1" } })).toEqual({ kind: "idle", sessionID: "s1" });
    expect(toUiEvent({ type: "session.error", properties: { error: { data: { message: "boom", statusCode: 500 } } } }))
      .toEqual({ kind: "error", message: "boom (HTTP 500)" });
    expect(toUiEvent({ type: "file.watcher.updated", properties: {} })).toBeNull();
    expect(toUiEvent(undefined)).toBeNull();
  });
});

describe("toUiMessages", () => {
  it("keeps the parts the UI renders and drops synthetic text and file:// urls", () => {
    const [m] = toUiMessages([{
      info: { id: "m1", role: "assistant", providerID: "scx", modelID: "GLM-5.3", tokens: { input: 1, output: 2 } },
      parts: [
        { type: "text", id: "t1", text: "hello" },
        { type: "text", id: "t2", text: "injected", synthetic: true },
        { type: "file", id: "f1", filename: "a.png", mime: "image/png", url: "data:image/png;base64,AAAA" },
        { type: "file", id: "f2", filename: "a.txt", mime: "text/plain", url: "file:///tmp/a.txt" },
        { type: "step-start" },
      ],
    }]);
    expect(m.model).toBe("scx/GLM-5.3");
    expect(m.parts).toEqual([
      { type: "text", id: "t1", text: "hello" },
      { type: "file", id: "f1", filename: "a.png", mime: "image/png", url: "data:image/png;base64,AAAA" },
      { type: "file", id: "f2", filename: "a.txt", mime: "text/plain", url: undefined },
    ]);
  });
});
