import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The workspace root is read at import time (CLONE_ROOT in opencode.ts).
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bxh-ws-"));
process.env.OPEN_RUNNER_WORKSPACE = root;
delete process.env.OPENCODE_URL;
const ws = await import("./workspaces.js");

const gitInit = (dir: string) => { fs.mkdirSync(dir, { recursive: true }); execFileSync("git", ["init", "-q", dir], { windowsHide: true }); };

describe("workspaces", () => {
  it("creates a named workspace as a git repository, and refuses bad or taken names", async () => {
    const w = await ws.createWorkspace("demo");
    expect(w).toMatchObject({ name: "demo", directory: path.join(root, "demo"), git: true });
    await expect(ws.createWorkspace("demo")).rejects.toMatchObject({ status: 409 });
    for (const bad of ["", "../x", "a/b", ".hidden", "-x", "x".repeat(65), 42]) {
      await expect(ws.createWorkspace(bad), String(bad)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("lists top-level folders, and an owner folder of clones as its repositories", () => {
    gitInit(path.join(root, "cintelis", "app"));
    gitInit(path.join(root, "cintelis", "site"));
    fs.mkdirSync(path.join(root, "plain"));
    const names = ws.listWorkspaces().map((w) => w.name).sort();
    expect(names).toEqual(["cintelis/app", "cintelis/site", "demo", "plain"]);
  });

  it("deletes only a listed workspace: not the root, not an owner folder, not a made-up path", () => {
    expect(() => ws.deleteWorkspace(root)).toThrow(/Not a workspace/);
    expect(() => ws.deleteWorkspace(path.join(root, "cintelis"))).toThrow(/Not a workspace/);
    expect(() => ws.deleteWorkspace(path.join(root, "nope"))).toThrow(/Not a workspace/);
    expect(() => ws.deleteWorkspace(os.tmpdir())).toThrow(/Not a workspace/);
    expect(ws.deleteWorkspace(path.join(root, "cintelis", "site")).name).toBe("cintelis/site");
    expect(fs.existsSync(path.join(root, "cintelis", "site"))).toBe(false);
    expect(fs.existsSync(path.join(root, "cintelis", "app"))).toBe(true);
  });
});

describe("project files", () => {
  const project = path.join(root, "demo");

  it("saves uploads without replacing anything, and lists folders first", () => {
    expect(ws.saveUpload(project, "", "report.md", Buffer.from("one"))).toEqual({ path: "report.md", name: "report.md", bytes: 3 });
    expect(ws.saveUpload(project, "", "report.md", Buffer.from("two")).name).toBe("report-1.md");
    expect(fs.readFileSync(path.join(project, "report.md"), "utf8")).toBe("one");
    fs.mkdirSync(path.join(project, "out"));
    expect(ws.saveUpload(project, "out", "..\\..\\evil.sh", Buffer.from("x"))).toMatchObject({ path: "out/evil.sh" });
    const top = ws.listFiles(project, "");
    expect(top.entries.map((e) => `${e.type}:${e.name}`)).toEqual(["dir:out", "file:report-1.md", "file:report.md"]);
    expect(ws.listFiles(project, "out").entries.map((e) => e.name)).toEqual(["evil.sh"]);
  });

  it("refuses folders outside the project", () => {
    expect(() => ws.listFiles(project, "../cintelis")).toThrow(/Not inside the project/);
    expect(() => ws.saveUpload(project, "../plain", "x.txt", Buffer.from("x"))).toThrow(/Not inside the project/);
    expect(() => ws.listFiles(project, "report.md")).toThrow(/Not a folder/);
    expect(() => ws.listFiles(project, "missing")).toThrow(/No such folder/);
  });
});
