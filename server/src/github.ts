/**
 * GitHub, read-only.
 *
 * One fine-grained personal access token (vault item GITHUB_TOKEN, else the
 * GITHUB_TOKEN variable, scrubbed from the environment in providers.ts) does
 * two things: lists the repositories it was granted, and clones or
 * fast-forwards them into the workspace. The user decides the reach on
 * GitHub's own screen when minting the token (which repositories; Contents:
 * read-only), and this module never pushes, writes or reads anything else.
 *
 * The token is passed to git through an environment-scoped config entry
 * (GIT_CONFIG_*), so it is in neither the command line nor the clone's
 * .git/config: the agent gets a plain working copy with an https origin and no
 * credentials, which is what keeps the integration read-only in the sandbox
 * too.
 *
 * The API helper's shape follows brainstorm-board's lib/github.ts; the OAuth
 * half was left there on purpose: a self-hosted runner has no app to register.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { CloneRequest, CloneResult, GitHubBranch, GitHubClone, GitHubRepo, GitHubStatus } from "../../shared/github.js";
import { httpError } from "./errors.js";
import { CLONE_ROOT, REMOTE_URL } from "./opencode.js";
import { secret, secretSource } from "./providers.js";
import * as vault from "./vault.js";

const execFileP = promisify(execFile);

export const TOKEN_ITEM = "GITHUB_TOKEN";
const API_BASE = process.env.GITHUB_API_BASE ?? "https://api.github.com";
/** Overridable so tests can clone from a local bare repository. */
const GIT_BASE = process.env.GITHUB_GIT_BASE ?? "https://github.com";
const NO_TOKEN = `No GitHub token. Create a fine-grained token on GitHub (only the repositories you choose, Contents: read-only) and add it to the vault as ${TOKEN_ITEM}.`;

// --- names and paths ----------------------------------------------------------------

/** `owner/name` (a trailing .git is tolerated), validated against GitHub's own rules. */
export function parseRepo(input: unknown): { owner: string; name: string; fullName: string } {
  const s = typeof input === "string" ? input.trim().replace(/\.git$/i, "") : "";
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,100})$/.exec(s);
  if (!m || m[2] === "." || m[2] === "..") throw httpError(400, `Not a repository name (owner/name): ${JSON.stringify(input)}`);
  return { owner: m[1], name: m[2], fullName: `${m[1]}/${m[2]}` };
}

/** A branch name git would accept, without the characters that change a command's meaning. */
export function validBranch(input: unknown): string {
  const b = typeof input === "string" ? input.trim() : "";
  const bad = !b || b.length > 200 || b.startsWith("-") || b.startsWith("/") || b.endsWith("/") || b.endsWith(".")
    || b.endsWith(".lock") || b.includes("..") || b.includes("//") || b.includes("@{") || /[\s~^:?*[\\\x00-\x1f\x7f]/.test(b);
  if (bad) throw httpError(400, `Not a branch name: ${JSON.stringify(input)}`);
  return b;
}

/** Where a repository is (or would be) cloned: `<CLONE_ROOT>/<owner>/<name>`. */
export function cloneDir(fullName: string): string {
  const { owner, name } = parseRepo(fullName);
  return (REMOTE_URL ? path.posix : path).join(CLONE_ROOT, owner, name);
}

const remoteUrl = (fullName: string) => `${GIT_BASE}/${fullName}.git`;

/** `owner/name` from a clone's origin URL, or null when it is not a GitHub remote. */
export function parseOriginUrl(url: string): string | null {
  let u = url.trim();
  // A non-default GIT_BASE (tests: a folder of bare repositories) counts as "GitHub" too.
  const base = GIT_BASE.replace(/\\/g, "/");
  if (base !== "https://github.com" && u.replace(/\\/g, "/").toLowerCase().startsWith(base.toLowerCase() + "/")) {
    u = "https://github.com/" + u.replace(/\\/g, "/").slice(base.length + 1);
  }
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(u);
  return m ? `${m[1]}/${m[2]}` : null;
}

// --- git ------------------------------------------------------------------------------

/**
 * The token as git sees it: a config entry scoped to this one process, so it
 * is never on a command line (visible in `ps`) and never written into the
 * clone. Credential helpers are switched off so a bad token fails at once
 * instead of popping a desktop prompt (Git Credential Manager on Windows).
 */
export function gitAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `http.${GIT_BASE}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
  };
}

async function git(args: string[], token: string, cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd, windowsHide: true, timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...gitAuthEnv(token) },
    });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; code?: unknown; message?: string };
    const text = String(err.stderr || err.message || e).split(/\r?\n/).filter((l) => l && !/^(remote: )?Enumerating|^Receiving|^Resolving|^Counting|^Compressing/.test(l)).slice(-4).join(" ");
    if (err.code === "ENOENT") throw httpError(503, "git is not installed on the runner.");
    const status = /Authentication failed|could not read Username|403|Repository not found/i.test(text) ? 403 : 502;
    // Belt and braces: the token travels in a header, never in output, but a clone's error is shown in the UI.
    throw httpError(status, `git ${args[0]} failed: ${text.split(token).join("***")}`);
  }
}

function readGitFile(dir: string, file: string): string | null {
  try { return fs.readFileSync(path.join(dir, ".git", file), "utf8"); } catch { return null; }
}

/** What a folder is a clone of, read from .git without spawning git. */
export function inspectClone(dir: string): GitHubClone | null {
  const config = readGitFile(dir, "config");
  if (!config) return null;
  // git escapes backslashes and quotes in config values.
  const origin = /\[remote "origin"\][^[]*?\n\s*url\s*=\s*(.+)/.exec(config)?.[1]?.trim().replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1");
  const fullName = origin ? parseOriginUrl(origin) : null;
  if (!fullName) return null;
  const head = readGitFile(dir, "HEAD") ?? "";
  const branch = /^ref: refs\/heads\/(.+?)\s*$/.exec(head)?.[1] ?? null;
  return { fullName, directory: dir, branch };
}

/** Clones under the clone root: ours (`owner/name`) and any the user made one level down. */
export function listClones(): GitHubClone[] {
  const out: GitHubClone[] = [];
  const join = REMOTE_URL ? path.posix.join : path.join;
  let owners: string[] = [];
  try { owners = fs.readdirSync(CLONE_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name); } catch { return out; }
  for (const owner of owners) {
    const ownerDir = join(CLONE_ROOT, owner);
    const direct = inspectClone(ownerDir);
    if (direct) { out.push(direct); continue; }
    let names: string[] = [];
    try { names = fs.readdirSync(ownerDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name); } catch { continue; }
    for (const name of names) {
      const c = inspectClone(join(ownerDir, name));
      if (c) out.push(c);
    }
  }
  return out.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

// --- the API --------------------------------------------------------------------------

function token(): string {
  const t = secret(TOKEN_ITEM); // throws 503 while the vault is sealed
  if (!t) throw httpError(503, NO_TOKEN);
  return t;
}

async function api<T>(tok: string, route: string): Promise<T> {
  const r = await fetch(`${API_BASE}${route}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tok}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bugxhunter-runner",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.ok) return (await r.json()) as T;
  let message = `GitHub answered ${r.status}`;
  try { message = ((await r.json()) as { message?: string }).message ?? message; } catch { /* no body */ }
  if (r.status === 401) throw httpError(502, `GitHub rejected the token (${message}). Replace ${TOKEN_ITEM} in the vault.`);
  throw httpError(r.status === 404 || r.status === 403 ? r.status : 502, `GitHub: ${message}`);
}

/** The token's account, remembered per token so the status call stays cheap. */
const logins = new Map<string, { login: string; at: number }>();
async function whoami(tok: string): Promise<string> {
  const key = crypto.createHash("sha256").update(tok).digest("hex");
  const hit = logins.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.login;
  const me = await api<{ login: string }>(tok, "/user");
  logins.set(key, { login: me.login, at: Date.now() });
  return me.login;
}

export async function status(): Promise<GitHubStatus> {
  const source = secretSource(TOKEN_ITEM);
  const base: GitHubStatus = { configured: source !== "none", source, sealed: false, login: null, error: null, cloneRoot: CLONE_ROOT, clones: listClones() };
  if (source === "none") return base;
  if (source === "vault" && !vault.isUnsealed()) return { ...base, sealed: true };
  try {
    return { ...base, login: await whoami(token()) };
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
}

interface RepoRow { full_name: string; description: string | null; default_branch: string; private: boolean; archived?: boolean; pushed_at?: string | null }

/** Every repository the token can see (a fine-grained token: the ones it was granted), newest push first. */
export async function listRepos(): Promise<GitHubRepo[]> {
  const tok = token();
  const rows: RepoRow[] = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await api<RepoRow[]>(tok, `/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`);
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  const clones = new Map(listClones().map((c) => [c.fullName.toLowerCase(), c.directory]));
  return rows.map((r) => ({
    fullName: r.full_name,
    description: r.description,
    defaultBranch: r.default_branch,
    private: r.private,
    archived: Boolean(r.archived),
    pushedAt: r.pushed_at ?? null,
    ...(clones.has(r.full_name.toLowerCase()) ? { directory: clones.get(r.full_name.toLowerCase()) } : {}),
  }));
}

export async function listBranches(repo: unknown): Promise<GitHubBranch[]> {
  const { fullName } = parseRepo(repo);
  const tok = token();
  const [info, branches] = await Promise.all([
    api<{ default_branch: string }>(tok, `/repos/${fullName}`),
    api<{ name: string }[]>(tok, `/repos/${fullName}/branches?per_page=100`),
  ]);
  return branches
    .map((b) => ({ name: b.name, isDefault: b.name === info.default_branch }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

// --- clone / update ------------------------------------------------------------------

const inFlight = new Map<string, Promise<CloneResult>>();

/**
 * Clone `owner/name` into the workspace, or fast-forward the clone that is
 * already there. Never a force, never a push: a clone the agent has edited
 * that cannot fast-forward is reported, not reset.
 */
export function cloneOrUpdate(req: CloneRequest): Promise<CloneResult> {
  const { fullName } = parseRepo(req?.repo);
  const dir = cloneDir(fullName);
  const running = inFlight.get(dir);
  if (running) throw httpError(409, `${fullName} is already being cloned.`);
  const p = doCloneOrUpdate(fullName, dir, req.branch === undefined || req.branch === "" ? undefined : validBranch(req.branch))
    .finally(() => inFlight.delete(dir));
  inFlight.set(dir, p);
  return p;
}

async function doCloneOrUpdate(fullName: string, dir: string, branch?: string): Promise<CloneResult> {
  const tok = token();
  if (fs.existsSync(dir)) {
    const existing = inspectClone(dir);
    if (!existing) throw httpError(409, `${dir} exists but is not a git clone. Move it aside first.`);
    if (existing.fullName.toLowerCase() !== fullName.toLowerCase()) throw httpError(409, `${dir} is a clone of ${existing.fullName}, not ${fullName}.`);
    const target = branch ?? existing.branch;
    if (!target) throw httpError(409, `${dir} has a detached HEAD. Choose a branch.`);
    await git(["-C", dir, "fetch", "--prune", "origin"], tok);
    if (target !== existing.branch) await git(["-C", dir, "checkout", target], tok); // validBranch: never starts with "-"
    await git(["-C", dir, "merge", "--ff-only", `origin/${target}`], tok);
    return { directory: dir, branch: target, action: "updated" };
  }
  const target = branch ?? (await api<{ default_branch: string }>(tok, `/repos/${fullName}`)).default_branch;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(["clone", "--branch", target, "--", remoteUrl(fullName), dir], tok);
  // The header lives in the process environment, so it cannot end up in the
  // clone's config. Check anyway: this is the file the agent will be able to read.
  const config = readGitFile(dir, "config") ?? "";
  if (/extraheader|AUTHORIZATION/i.test(config)) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw httpError(500, "The clone's .git/config held credentials; it was removed.");
  }
  return { directory: dir, branch: target, action: "cloned" };
}
