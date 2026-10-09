import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionFamily, markInterrupted, parseModelId, projectFile, query, toUiEvent, toUiMessages } from "./opencode.js";

describe("projectFile", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bxh-proj-"));
  fs.mkdirSync(path.join(dir, "out"));
  fs.writeFileSync(path.join(dir, "out", "report.md"), "# r");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bxh-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "x");

  it("accepts an absolute or project-relative path to a file inside the project", () => {
    const want = fs.realpathSync(path.join(dir, "out", "report.md"));
    expect(projectFile(dir, path.join(dir, "out", "report.md"))).toBe(want);
    expect(projectFile(dir, "out/report.md")).toBe(want);
  });
  it("refuses escapes, folders, missing files and empty paths", () => {
    expect(() => projectFile(dir, "../" + path.basename(outside) + "/secret.txt")).toThrow(/Not inside/);
    expect(() => projectFile(dir, path.join(outside, "secret.txt"))).toThrow(/Not inside/);
    expect(() => projectFile(dir, "out")).toThrow(/Not a file/);
    expect(() => projectFile(dir, "out/missing.md")).toThrow(/No such file/);
    expect(() => projectFile(dir, "")).toThrow(/path required/);
  });
});

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

describe("SessionFamily", () => {
  const text = (sessionID: string, id = "p1") =>
    ({ type: "message.part.updated", properties: { part: { type: "text", id, messageID: "m-" + sessionID, sessionID, text: "hi" } } });
  const perm = (sessionID: string) =>
    ({ type: "permission.asked", properties: { id: "perm-" + sessionID, sessionID, type: "bash", title: "ls", pattern: "ls *" } });

  it("passes the root session's events through untouched", () => {
    const f = new SessionFamily("root");
    expect(f.relay(text("root"))).toEqual({ kind: "text", messageID: "m-root", partID: "p1", text: "hi" });
    expect(f.relay(perm("root"))).toMatchObject({ kind: "permission", sessionID: "root" });
    expect(f.relay(perm("root"))).not.toHaveProperty("subagent");
  });

  it("tags a subagent's output and prompts with its title, and drops strangers", () => {
    const f = new SessionFamily("root", [{ id: "kid", parentID: "root", title: "Find endpoints (@explore subagent)" }]);
    expect(f.relay(text("kid"))).toMatchObject({ kind: "text", messageID: "m-kid", subagent: "Find endpoints (@explore subagent)" });
    expect(f.relay(perm("kid"))).toMatchObject({ kind: "permission", sessionID: "kid", subagent: "Find endpoints (@explore subagent)" });
    expect(f.relay(text("other"))).toBeNull();
    expect(f.has("kid")).toBe(true);
    expect(f.has("other")).toBe(false);
    expect(f.subagent("root")).toBeUndefined();
  });

  it("adopts subagents announced on the stream, grandchildren included", () => {
    const f = new SessionFamily("root");
    expect(f.relay(text("kid"))).toBeNull();
    expect(f.relay({ type: "session.created", properties: { info: { id: "kid", parentID: "root", title: "kid" } } })).toBeNull();
    expect(f.relay(text("kid"))).toMatchObject({ subagent: "kid" });
    expect(f.relay({ type: "session.updated", properties: { info: { id: "grandkid", parentID: "kid" } } })).toBeNull();
    expect(f.relay(text("grandkid"))).toMatchObject({ subagent: "subagent" });
    // The root's own session.updated still reaches the UI (title changes).
    expect(f.relay({ type: "session.updated", properties: { info: { id: "root", title: "T" } } })).toEqual({ kind: "session", sessionID: "root", title: "T" });
  });

  it("never lets a subagent's idle, error or todos end or hijack the parent's turn", () => {
    const f = new SessionFamily("root", [{ id: "kid", parentID: "root", title: "kid" }]);
    expect(f.relay({ type: "session.idle", properties: { sessionID: "kid" } })).toBeNull();
    expect(f.relay({ type: "session.error", properties: { sessionID: "kid", error: { name: "E" } } })).toBeNull();
    expect(f.relay({ type: "todo.updated", properties: { sessionID: "kid", todos: [] } })).toBeNull();
    expect(f.relay({ type: "session.idle", properties: { sessionID: "root" } })).toEqual({ kind: "idle", sessionID: "root" });
  });

  it("seeds children listed before their parent", () => {
    const f = new SessionFamily("root", [{ id: "grandkid", parentID: "kid" }, { id: "kid", parentID: "root" }]);
    expect(f.has("grandkid")).toBe(true);
  });
});

describe("markInterrupted", () => {
  const msgs = [{
    id: "m1", role: "assistant" as const,
    parts: [
      { type: "tool" as const, callID: "c1", tool: "bash", status: "running" },
      { type: "tool" as const, callID: "c2", tool: "bash", status: "completed" },
      { type: "text" as const, id: "t1", text: "x" },
    ],
  }];
  it("marks running/pending tool calls of an idle session interrupted and leaves the rest", () => {
    const out = markInterrupted(msgs, true);
    expect(out[0].parts.map((p) => (p.type === "tool" ? p.status : p.type))).toEqual(["interrupted", "completed", "text"]);
    expect(msgs[0].parts[0]).toMatchObject({ status: "running" }); // input untouched
  });
  it("leaves a busy session alone", () => {
    expect(markInterrupted(msgs, false)).toBe(msgs);
  });
});
