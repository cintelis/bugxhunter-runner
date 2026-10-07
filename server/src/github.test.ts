import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate everything the module reads at import time: the vault file (none,
// so the sign-in is kept in memory), the clone root, and a local "GitHub"
// that is just a folder of bare repositories.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bxh-gh-"));
const remotes = path.join(tmp, "remotes");
process.env.OPEN_RUNNER_VAULT_FILE = path.join(tmp, "vault.json");
process.env.OPEN_RUNNER_WORKSPACE = path.join(tmp, "repos");
process.env.GITHUB_GIT_BASE = remotes;
process.env.GITHUB_APP_SLUG = "bugxhunter-test";
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

// One fake GitHub for the whole file: the OAuth endpoints (device flow,
// refresh) and the few REST routes the module uses. `state` steers it.
const state = { approved: false, polls: 0, token: "tok-1", refreshes: 0, calls: [] as string[] };
const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  state.calls.push(u);
  const form = typeof init?.body === "string" ? new URLSearchParams(init.body) : new URLSearchParams();
  if (u.endsWith("/login/device/code")) {
    expect(form.get("client_id")).toBe(github.CLIENT_ID);
    return Response.json({ device_code: "dev-123", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
  }
  if (u.endsWith("/login/oauth/access_token")) {
    expect(form.get("client_id")).toBe(github.CLIENT_ID);
    expect(form.has("client_secret")).toBe(false);
    if (form.get("grant_type") === "refresh_token") {
      state.refreshes++;
      if (form.get("refresh_token") !== "ref-1") return Response.json({ error: "bad_refresh_token" });
      return Response.json({ access_token: "tok-2", refresh_token: "ref-2", expires_in: 28800 });
    }
    state.polls++;
    if (!state.approved) return Response.json({ error: "authorization_pending" });
    return Response.json({ access_token: state.token, refresh_token: "ref-1", expires_in: 28800 });
  }
  const auth = (init?.headers as Record<string, string>).Authorization;
  if (auth !== `Bearer ${state.token}`) return Response.json({ message: "Bad credentials" }, { status: 401 });
  if (u.endsWith("/user")) return Response.json({ login: "nick" });
  if (u.includes("/user/repos")) {
    const page = Number(new URL(u).searchParams.get("page"));
    if (page === 1) return Response.json(Array.from({ length: 100 }, (_, i) => ({ full_name: `o/r${i}`, description: null, default_branch: "main", private: i % 2 === 0, pushed_at: "2026-10-01T00:00:00Z" })));
    return Response.json([{ full_name: "cintelis/demo", description: "d", default_branch: "trunk", private: true, archived: true, pushed_at: null }]);
  }
  if (u.endsWith("/repos/cintelis/demo")) return Response.json({ default_branch: "main" });
  if (u.endsWith("/repos/cintelis/demo/branches?per_page=100")) return Response.json([{ name: "a" }, { name: "main" }, { name: "b" }]);
  if (u.endsWith("/repos/cintelis/gone")) return Response.json({ message: "Not Found" }, { status: 404 });
  return Response.json({ message: "unexpected" }, { status: 500 });
});
beforeAll(() => vi.stubGlobal("fetch", fetchMock));
afterAll(() => vi.unstubAllGlobals());

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

describe("git credentials", () => {
  it("hands git the token in a process-scoped header, never an argument, with credential helpers off", () => {
    const env = github.gitAuthEnv("secret-token");
    expect(env.GIT_CONFIG_KEY_0).toBe(`http.${remotes}/.extraheader`);
    expect(env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${Buffer.from("x-access-token:secret-token").toString("base64")}`);
    expect(env.GIT_CONFIG_KEY_1).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_1).toBe("");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(JSON.stringify(env)).not.toContain("secret-token");
  });
});

describe("signing in (device flow)", () => {
  it("starts disconnected, with the app's install page known", async () => {
    const s = await github.status();
    expect(s).toMatchObject({ connected: false, sealed: false, login: null, storage: "memory", installUrl: "https://github.com/apps/bugxhunter-test/installations/new" });
    await expect(github.listRepos()).rejects.toMatchObject({ status: 503, message: expect.stringContaining("Not connected") });
  });
  it("hands out a user code, polls at GitHub's pace, then stores the tokens and the login", async () => {
    const start = await github.connectStart();
    expect(start).toMatchObject({ userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", interval: 5 });
    expect(await github.connectPoll(start.id)).toEqual({ status: "pending" });
    // A second poll inside the interval never reaches GitHub.
    expect(await github.connectPoll(start.id)).toEqual({ status: "pending" });
    expect(state.polls).toBe(1);
    state.approved = true;
    vi.useFakeTimers({ now: Date.now() + 6000 });
    try {
      expect(await github.connectPoll(start.id)).toEqual({ status: "connected", login: "nick", storage: "memory" });
    } finally {
      vi.useRealTimers();
    }
    await expect(github.connectPoll(start.id)).rejects.toMatchObject({ status: 404 });
    expect(await github.status()).toMatchObject({ connected: true, login: "nick", error: null });
  });
  it("rejects unknown attempts", async () => {
    await expect(github.connectPoll("nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("the API, signed in", () => {
  it("follows pagination and keeps the shape the UI wants", async () => {
    const repos = await github.listRepos();
    expect(repos).toHaveLength(101);
    expect(repos.at(-1)).toEqual({ fullName: "cintelis/demo", description: "d", defaultBranch: "trunk", private: true, archived: true, pushedAt: null });
  });
  it("lists branches with the default first", async () => {
    expect(await github.listBranches("cintelis/demo")).toEqual([{ name: "main", isDefault: true }, { name: "a", isDefault: false }, { name: "b", isDefault: false }]);
  });
  it("keeps GitHub's 404 as a 404", async () => {
    await expect(github.listBranches("cintelis/gone")).rejects.toMatchObject({ status: 404, message: "GitHub: Not Found" });
  });
  it("refreshes an expired token without a client secret", async () => {
    vi.useFakeTimers({ now: Date.now() + 9 * 3600 * 1000 });
    try {
      state.token = "tok-2";
      expect(await github.listBranches("cintelis/demo")).toHaveLength(3);
      expect(state.refreshes).toBe(1);
      expect(state.calls.at(-1)).toContain("/repos/cintelis/demo");
    } finally {
      vi.useRealTimers();
    }
  });
  it("drops a connection GitHub has revoked and says to connect again", async () => {
    state.token = "revoked-elsewhere";
    await expect(github.listBranches("cintelis/demo")).rejects.toMatchObject({ status: 503, message: expect.stringContaining("Connect again") });
    expect(await github.status()).toMatchObject({ connected: false });
    state.token = "tok-2";
  });
});

describe("clone and update (real git, local bare remote)", () => {
  beforeAll(async () => {
    // Sign in again for the clone (the previous test revoked the connection).
    state.approved = true;
    const start = await github.connectStart();
    vi.useFakeTimers({ now: Date.now() + 6000 });
    try { expect(await github.connectPoll(start.id)).toMatchObject({ status: "connected" }); } finally { vi.useRealTimers(); }
  });

  it("clones on the default branch, with a clean config, then fast-forwards", async () => {
    const { work } = makeRemote("cintelis/demo");
    const first = await github.cloneOrUpdate({ repo: "cintelis/demo" });
    expect(first).toEqual({ directory: github.cloneDir("cintelis/demo"), branch: "main", action: "cloned" });
    const readme = () => fs.readFileSync(path.join(first.directory, "README.md"), "utf8").trim(); // trim: autocrlf on Windows
    expect(readme()).toBe("# one");
    const config = fs.readFileSync(path.join(first.directory, ".git", "config"), "utf8");
    expect(config).not.toMatch(/extraheader|AUTHORIZATION|tok-/i);
    expect(github.listClones()).toEqual([{ fullName: "cintelis/demo", directory: first.directory, branch: "main" }]);
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
  it("disconnects", async () => {
    github.disconnect();
    expect(await github.status()).toMatchObject({ connected: false, login: null });
  });
});
