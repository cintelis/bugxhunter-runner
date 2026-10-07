/**
 * GitHub, read-only.
 *
 * The runner signs in to the public "BugXHunter" GitHub App with the device
 * flow (the thing `gh auth login` does): a short code typed at
 * github.com/login/device, no callback URL and no client secret, so one app
 * registration serves every self-hosted runner. The app declares Contents:
 * read-only and Metadata: read-only, and its user token reaches only the
 * repositories the app was INSTALLED on ("Choose repositories"), so the reach
 * is chosen and bounded by the user on GitHub's own screens. Tokens expire
 * after eight hours and refresh; the pair is kept in the vault (item
 * GITHUB_OAUTH), or in memory until restart when there is no vault yet.
 *
 * The token does two things: lists the repositories it reaches, and clones or
 * fast-forwards them into the workspace. Nothing here pushes, writes or reads
 * anything else.
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
import type { CloneRequest, CloneResult, DeviceStart, DevicePoll, GitHubBranch, GitHubClone, GitHubRepo, GitHubStatus } from "../../shared/github.js";
import { httpError } from "./errors.js";
import { CLONE_ROOT, REMOTE_URL } from "./opencode.js";
import * as vault from "./vault.js";

const execFileP = promisify(execFile);

/** The signed-in connection (tokens + login), as JSON. */
export const CONNECTION_ITEM = "GITHUB_OAUTH";
/** The public BugXHunter GitHub App. Forks register their own and override these. */
export const CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? "Iv23lijniIcrEZ0ZFNWD";
export const APP_SLUG = process.env.GITHUB_APP_SLUG ?? "bugxhunter";
const API_BASE = process.env.GITHUB_API_BASE ?? "https://api.github.com";
const OAUTH_BASE = process.env.GITHUB_OAUTH_BASE ?? "https://github.com";
/** Overridable so tests can clone from a local bare repository. */
const GIT_BASE = process.env.GITHUB_GIT_BASE ?? "https://github.com";
const NOT_CONNECTED = "Not connected to GitHub. Sidebar → clone from GitHub → Connect GitHub.";

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

// --- the signed-in connection (GitHub App, device flow) ------------------------------

interface Connection {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; absent for a token that does not expire. */
  expiresAt?: number;
  login: string;
}

/** Where the connection lives when there is no vault to seal it in: this process only. */
let memoryConnection: Connection | null = null;

function connectionStorage(): "vault" | "memory" | "sealed" {
  if (!vault.isInitialised()) return "memory";
  return vault.isUnsealed() ? "vault" : "sealed";
}

function loadConnection(): Connection | null {
  if (connectionStorage() === "vault") {
    const raw = vault.getItem(CONNECTION_ITEM);
    if (!raw) return null;
    try { return JSON.parse(raw) as Connection; } catch { return null; }
  }
  return memoryConnection;
}

function saveConnection(c: Connection | null): "vault" | "memory" {
  const where = connectionStorage();
  if (where === "sealed") throw httpError(503, "The vault is locked. Unlock it (lock icon in the sidebar) and try again.");
  if (where === "vault") {
    if (c) vault.setItem(CONNECTION_ITEM, JSON.stringify(c));
    else if (vault.status("none").items.includes(CONNECTION_ITEM)) vault.deleteItem(CONNECTION_ITEM);
    memoryConnection = null;
  } else {
    memoryConnection = c;
  }
  return where;
}

export function disconnect(): void {
  saveConnection(null);
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
  interval?: number;
}

/** POST to GitHub's OAuth endpoints (form in, JSON out). No client secret: the device flow has none. */
async function oauthPost(path: string, params: Record<string, string>): Promise<TokenResponse> {
  const r = await fetch(`${OAUTH_BASE}${path}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "bugxhunter-runner" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw httpError(502, `GitHub sign-in endpoint answered ${r.status}`);
  return (await r.json()) as TokenResponse;
}

function tokensFrom(data: TokenResponse, login: string): Connection {
  if (!data.access_token) throw httpError(502, data.error_description || data.error || "GitHub returned no token");
  const c: Connection = { accessToken: data.access_token, login };
  if (data.refresh_token) {
    c.refreshToken = data.refresh_token;
    // A minute early, so a token is never presented at the edge of expiry.
    if (typeof data.expires_in === "number" && data.expires_in > 0) c.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  }
  return c;
}

/** Device flows started from this process, by an opaque id the browser polls with. */
const pendingDevice = new Map<string, { deviceCode: string; interval: number; expiresAt: number; nextPoll: number }>();

/** Step 1: ask GitHub for a code the person types at github.com/login/device. */
export async function connectStart(): Promise<DeviceStart> {
  if (connectionStorage() === "sealed") throw httpError(503, "The vault is locked. Unlock it first so the connection can be sealed in it.");
  const d = (await oauthPost("/login/device/code", {})) as TokenResponse & { device_code?: string; user_code?: string; verification_uri?: string };
  if (!d.device_code || !d.user_code) throw httpError(502, d.error_description || d.error || "GitHub did not start a device sign-in");
  for (const [k, v] of pendingDevice) if (v.expiresAt < Date.now()) pendingDevice.delete(k);
  const id = crypto.randomBytes(16).toString("base64url");
  const interval = Math.max(5, d.interval ?? 5);
  pendingDevice.set(id, { deviceCode: d.device_code, interval, expiresAt: Date.now() + (d.expires_in ?? 900) * 1000, nextPoll: 0 });
  return { id, userCode: d.user_code, verificationUri: d.verification_uri ?? `${OAUTH_BASE}/login/device`, expiresIn: d.expires_in ?? 900, interval };
}

/**
 * Step 2, repeated: has the person approved yet? GitHub's polling interval is
 * respected here no matter how often the browser asks (a faster poll earns a
 * `slow_down`). On approval the tokens are stored and the login looked up.
 */
export async function connectPoll(id: unknown): Promise<DevicePoll> {
  const p = typeof id === "string" ? pendingDevice.get(id) : undefined;
  if (!p) throw httpError(404, "That sign-in attempt is unknown or has expired. Start again.");
  const key = id as string;
  if (p.expiresAt < Date.now()) { pendingDevice.delete(key); return { status: "expired" }; }
  if (Date.now() < p.nextPoll) return { status: "pending" };
  p.nextPoll = Date.now() + p.interval * 1000;
  const data = await oauthPost("/login/oauth/access_token", { device_code: p.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
  switch (data.error) {
    case "authorization_pending": return { status: "pending" };
    case "slow_down": p.interval = Math.max(p.interval, (data.interval ?? p.interval) + 5); p.nextPoll = Date.now() + p.interval * 1000; return { status: "pending" };
    case "expired_token": pendingDevice.delete(key); return { status: "expired" };
    case "access_denied": pendingDevice.delete(key); return { status: "denied" };
    case undefined: break;
    default: pendingDevice.delete(key); throw httpError(502, `GitHub: ${data.error_description || data.error}`);
  }
  pendingDevice.delete(key);
  const partial = tokensFrom(data, "");
  const me = await api<{ login: string }>(partial.accessToken, "/user");
  const storage = saveConnection({ ...partial, login: me.login });
  return { status: "connected", login: me.login, storage };
}

/** A usable access token from the connection, refreshing it when it has expired. Null when not connected. */
async function connectionToken(): Promise<string | null> {
  const c = loadConnection();
  if (!c) return null;
  if (!c.expiresAt || Date.now() < c.expiresAt) return c.accessToken;
  if (!c.refreshToken) { saveConnection(null); throw httpError(503, "The GitHub connection has expired. Connect again."); }
  let next: Connection;
  try {
    next = tokensFrom(await oauthPost("/login/oauth/access_token", { grant_type: "refresh_token", refresh_token: c.refreshToken }), c.login);
  } catch {
    // A refresh token is single use and lasts six months; one that no longer
    // works cannot be repaired from here.
    saveConnection(null);
    throw httpError(503, "GitHub would not renew the connection. Connect again.");
  }
  saveConnection(next);
  return next.accessToken;
}

/** The token for this call. */
async function token(): Promise<string> {
  const c = await connectionToken();
  if (!c) throw httpError(503, NOT_CONNECTED);
  return c;
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
  if (r.status === 401) {
    // Revoked on GitHub's side: drop our copy and say so, rather than "Bad credentials" on every click.
    if (connectionStorage() !== "sealed") saveConnection(null);
    throw httpError(503, `GitHub no longer accepts the connection (${message}). Connect again.`);
  }
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
  const storage = connectionStorage();
  const connected = storage !== "sealed" && loadConnection() !== null;
  const base: GitHubStatus = {
    connected, sealed: false, login: null, error: null,
    installUrl: `${OAUTH_BASE}/apps/${encodeURIComponent(APP_SLUG)}/installations/new`,
    storage: storage === "sealed" ? null : storage,
    cloneRoot: CLONE_ROOT, clones: listClones(),
  };
  if (storage === "sealed") {
    // The sign-in may be in the vault; say so rather than "not connected".
    return vault.status("none").items.includes(CONNECTION_ITEM) ? { ...base, connected: true, sealed: true } : base;
  }
  if (!connected) return base;
  try {
    return { ...base, login: await whoami(await token()) };
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
}

interface RepoRow { full_name: string; description: string | null; default_branch: string; private: boolean; archived?: boolean; pushed_at?: string | null }

/** Every repository the token can see (a fine-grained token: the ones it was granted), newest push first. */
export async function listRepos(): Promise<GitHubRepo[]> {
  const tok = await token();
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
  const tok = await token();
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
  const tok = await token();
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
