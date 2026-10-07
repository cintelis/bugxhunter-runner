import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate everything the module reads at import time: the vault file, the
// clone root, a token (captured and scrubbed by providers.ts) and a local
// "GitHub" that is just a folder of bare repositories.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bxh-gh-"));
const remotes = path.join(tmp, "remotes");
process.env.OPEN_RUNNER_VAULT_FILE = path.join(tmp, "vault.json");
process.env.OPEN_RUNNER_WORKSPACE = path.join(tmp, "repos");
process.env.GITHUB_TOKEN = "ghp_test_token_value";
process.env.GITHUB_GIT_BASE = remotes;
delete process.env.OPENCODE_URL;
const github = await import("./github.js");

const git = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, stdio: "pipe", windowsHide: true }).toString();

/** A bare repository at remotes/owner/name.git with one commit on `main`, and a working copy to push more from. */
function makeRemote(fullName: string) {
  const bare = path.join(remotes, `${fullName}.git`);
  const work = path.join(tmp, "work", fullName);
  fs.mkdirSync(bare, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  git(["init", "--bare", "-b", "main", bare]);
  git(["init", "-b", "main", work]);
  git(["config", "user.email", "t@example.com"], work);
  git(["config", "user.name", "t"], work);
  fs.writeFileSync(path.join(work, "README.md"), "# one\n");
  git(["add", "."], work);
  git(["commit", "-q", "-m", "one"], work);
  git(["remote", "add", "origin", bare], work);
  git(["push", "-q", "origin", "main"], work);
  return { bare, work };
}

describe("names", () => {
  it("accepts owner/name and strips .git", () => {
    expect(github.parseRepo("cintelis/bugxhunter-runner.git").fullName).toBe("cintelis/bugxhunter-runner");
    expect(github.parseRepo(" a/b.c_d-e ")).toEqual({ owner: "a", name: "b.c_d-e", fullName: "a/b.c_d-e" });
  });
  it("refuses anything that is not owner/name", () => {
    for (const bad of ["", "name", "a/b/c", "../x", "a/..", "-a/b", "a/b c", "a/b;rm", 42, null]) {
      expect(() => github.parseRepo(bad), String(bad)).toThrow(/Not a repository name/);
    }
  });
  it("validates branch names", () => {
    expect(github.validBranch("main")).toBe("main");
    expect(github.validBranch("feature/x.y")).toBe("feature/x.y");
    for (const bad of ["", "-x", "a..b", "a b", "a~1", "x.lock", "/a", "a/", "a@{1}", "a:b", "a\\b"]) {
      expect(() => github.validBranch(bad), bad).toThrow(/Not a branch name/);
    }
  });
  it("puts clones under <root>/<owner>/<name>", () => {
    expect(github.cloneDir("cintelis/x")).toBe(path.join(process.env.OPEN_RUNNER_WORKSPACE!, "cintelis", "x"));
  });
  it("reads owner/name from the origin URLs GitHub hands out", () => {
    expect(github.parseOriginUrl("https://github.com/cintelis/x.git")).toBe("cintelis/x");
    expect(github.parseOriginUrl("https://github.com/cintelis/x")).toBe("cintelis/x");
    expect(github.parseOriginUrl("git@github.com:cintelis/x.git")).toBe("cintelis/x");
    expect(github.parseOriginUrl("ssh://git@github.com/cintelis/x.git")).toBe("cintelis/x");
    expect(github.parseOriginUrl("https://gitlab.com/cintelis/x.git")).toBeNull();
    expect(github.parseOriginUrl("https://github.com/cintelis/x/../y")).toBeNull();
  });
});

describe("token handling", () => {
  it("hands git the token in a process-scoped header, never an argument, with credential helpers off", () => {
    const env = github.gitAuthEnv("secret-token");
    expect(env.GIT_CONFIG_KEY_0).toBe(`http.${remotes}/.extraheader`);
    expect(env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${Buffer.from("x-access-token:secret-token").toString("base64")}`);
    expect(env.GIT_CONFIG_KEY_1).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_1).toBe("");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(JSON.stringify(env)).not.toContain("secret-token");
  });
  it("was scrubbed from the environment, so the agent cannot inherit it", () => {
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
  });
});

describe("the API", () => {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ghp_test_token_value");
    if (u.endsWith("/user")) return Response.json({ login: "nick" });
    if (u.includes("/user/repos")) {
      const page = Number(new URL(u).searchParams.get("page"));
      if (page === 1) return Response.json(Array.from({ length: 100 }, (_, i) => ({ full_name: `o/r${i}`, description: null, default_branch: "main", private: i % 2 === 0, pushed_at: "2026-10-01T00:00:00Z" })));
      return Response.json([{ full_name: "cintelis/demo", description: "d", default_branch: "trunk", private: true, archived: true, pushed_at: null }]);
    }
    if (u.endsWith("/repos/cintelis/demo")) return Response.json({ default_branch: "trunk" });
    if (u.endsWith("/repos/cintelis/demo/branches?per_page=100")) return Response.json([{ name: "a" }, { name: "trunk" }, { name: "b" }]);
    if (u.endsWith("/repos/cintelis/gone")) return Response.json({ message: "Not Found" }, { status: 404 });
    if (u.endsWith("/repos/cintelis/bad")) return Response.json({ message: "Bad credentials" }, { status: 401 });
    return Response.json({ message: "unexpected" }, { status: 500 });
  });
  beforeAll(() => vi.stubGlobal("fetch", fetchMock));
  afterAll(() => vi.unstubAllGlobals());

  it("reports the token's account and that the token comes from the environment", async () => {
    const s = await github.status();
    expect(s).toMatchObject({ configured: true, source: "env", sealed: false, login: "nick", error: null, cloneRoot: process.env.OPEN_RUNNER_WORKSPACE });
    await github.status();
    expect(calls.filter((c) => c.endsWith("/user"))).toHaveLength(1); // cached per token
  });
  it("follows pagination and keeps the shape the UI wants", async () => {
    const repos = await github.listRepos();
    expect(repos).toHaveLength(101);
    expect(repos.at(-1)).toEqual({ fullName: "cintelis/demo", description: "d", defaultBranch: "trunk", private: true, archived: true, pushedAt: null });
  });
  it("lists branches with the default first", async () => {
    expect(await github.listBranches("cintelis/demo")).toEqual([{ name: "trunk", isDefault: true }, { name: "a", isDefault: false }, { name: "b", isDefault: false }]);
  });
  it("maps GitHub's errors: 404 stays, a bad token becomes an upstream failure that names the vault item", async () => {
    await expect(github.listBranches("cintelis/gone")).rejects.toMatchObject({ status: 404, message: "GitHub: Not Found" });
    await expect(github.listBranches("cintelis/bad")).rejects.toMatchObject({ status: 502, message: expect.stringContaining("GITHUB_TOKEN") });
  });
});

describe("clone and update (real git, local bare remote)", () => {
  const fetchMock = vi.fn(async (url: string | URL) => {
    if (String(url).endsWith("/repos/cintelis/demo")) return Response.json({ default_branch: "main" });
    return Response.json({ message: "unexpected" }, { status: 500 });
  });
  beforeAll(() => vi.stubGlobal("fetch", fetchMock));
  afterAll(() => vi.unstubAllGlobals());

  it("clones on the default branch, with a clean config, then fast-forwards", async () => {
    const { work } = makeRemote("cintelis/demo");
    const first = await github.cloneOrUpdate({ repo: "cintelis/demo" });
    expect(first).toEqual({ directory: github.cloneDir("cintelis/demo"), branch: "main", action: "cloned" });
    const readme = () => fs.readFileSync(path.join(first.directory, "README.md"), "utf8").trim(); // trim: autocrlf on Windows
    expect(readme()).toBe("# one");
    const config = fs.readFileSync(path.join(first.directory, ".git", "config"), "utf8");
    expect(config).not.toMatch(/extraheader|AUTHORIZATION|ghp_test/i);
    expect(github.listClones()).toEqual([{ fullName: "cintelis/demo", directory: first.directory, branch: "main" }]);
    // The runner's own clone is read-only for the agent by construction, but
    // the runner itself must see what the world pushed since.
    fs.writeFileSync(path.join(work, "README.md"), "# two\n");
    git(["commit", "-q", "-am", "two"], work);
    git(["push", "-q", "origin", "main"], work);
    const second = await github.cloneOrUpdate({ repo: "cintelis/demo", branch: "main" });
    expect(second).toEqual({ directory: first.directory, branch: "main", action: "updated" });
    expect(readme()).toBe("# two");
  });
  it("refuses a folder that is not a clone of that repository", async () => {
    const dir = github.cloneDir("cintelis/other");
    fs.mkdirSync(dir, { recursive: true });
    await expect(github.cloneOrUpdate({ repo: "cintelis/other" })).rejects.toMatchObject({ status: 409 });
  });
  it("reports a missing repository instead of hanging on a prompt", async () => {
    await expect(github.cloneOrUpdate({ repo: "cintelis/missing", branch: "main" })).rejects.toMatchObject({ status: expect.any(Number), message: expect.stringContaining("git clone failed") });
  });
});
