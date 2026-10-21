/**
 * Workspaces and the files in them.
 *
 * A workspace is a folder under the workspace root: /workspace in Docker
 * (the volume both containers mount at the same path), or
 * OPEN_RUNNER_WORKSPACE / ~/bugxhunter/repos locally — the same place GitHub
 * clones land. A clone sits one level deeper (<owner>/<repo>), so a folder
 * holding only other git repositories is listed as those repositories.
 *
 * Deleting only ever removes something listWorkspaces() would show: never the
 * root, never an owner folder of clones, never a path the browser made up.
 *
 * Files: list a folder of the current project, and save uploads into one.
 * Downloads use projectFile (index.ts). Everything is confined to the project
 * folder with symlinks resolved (projectPath).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ProjectEntry, Workspace } from "../../shared/agent.js";
import { safeName } from "./attachments.js";
import { httpError } from "./errors.js";
import { CLONE_ROOT, isInside, projectPath, REMOTE_URL } from "./opencode.js";

const execFileP = promisify(execFile);

/** Where workspaces live. */
export const WORKSPACES_ROOT = CLONE_ROOT;
const P = REMOTE_URL ? path.posix : path;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_ENTRIES = 2000;

const isGit = (p: string) => fs.existsSync(P.join(p, ".git"));
const modified = (p: string) => { try { return fs.statSync(p).mtime.toISOString(); } catch { return null; } };
const children = (p: string) => {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name); } catch { return []; }
};

export function listWorkspaces(): Workspace[] {
  const out: Workspace[] = [];
  for (const name of children(WORKSPACES_ROOT)) {
    const dir = P.join(WORKSPACES_ROOT, name);
    const inner = isGit(dir) ? [] : children(dir).filter((c) => isGit(P.join(dir, c)));
    if (inner.length) {
      // An owner folder of GitHub clones: list the repositories in it.
      for (const c of inner) out.push({ name: `${name}/${c}`, directory: P.join(dir, c), git: true, modified: modified(P.join(dir, c)) });
    } else {
      out.push({ name, directory: dir, git: isGit(dir), modified: modified(dir) });
    }
  }
  return out.sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
}

/** A new, empty workspace, initialised as a git repository (the Changes view diffs against it). */
export async function createWorkspace(name: unknown): Promise<Workspace> {
  const n = typeof name === "string" ? name.trim() : "";
  if (!NAME.test(n)) throw httpError(400, "A workspace name is letters, digits, dot, dash or underscore (up to 64), starting with a letter or digit.");
  fs.mkdirSync(WORKSPACES_ROOT, { recursive: true });
  const dir = P.join(WORKSPACES_ROOT, n);
  try { fs.mkdirSync(dir); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw httpError(409, `A workspace called ${n} already exists.`);
    throw e;
  }
  try { await execFileP("git", ["init", "-q", "-b", "main", dir], { windowsHide: true, timeout: 15_000 }); } catch { /* no git: still a usable folder */ }
  return { name: n, directory: dir, git: isGit(dir), modified: modified(dir) };
}

/**
 * A permission error, explained. The usual cause is a folder copied in with
 * plain `docker cp`, which leaves it owned by root while the runner and agent
 * run as node.
 */
function notWritable(e: unknown, dir: string): unknown {
  const code = (e as NodeJS.ErrnoException).code;
  if (code !== "EACCES" && code !== "EPERM") return e;
  return httpError(403, `No permission to write in ${dir}. It is probably owned by root because it was copied in with docker cp. ` +
    `Give it back to BugXHunter with: docker run --rm -u root -v bugxhunter_workspace:/workspace --entrypoint chown ghcr.io/cintelis/bugxhunter-agent -R node:node ${dir}`);
}

/** Delete a workspace and everything in it. Only a listed workspace qualifies. */
export function deleteWorkspace(directory: unknown): Workspace {
  const want = typeof directory === "string" ? P.resolve(directory.trim()) : "";
  const ws = listWorkspaces().find((w) => w.directory === want);
  if (!ws) throw httpError(404, "Not a workspace.");
  if (ws.directory === WORKSPACES_ROOT || !isInside(ws.directory, WORKSPACES_ROOT)) throw httpError(400, "Not a workspace.");
  const real = fs.realpathSync(ws.directory);
  if (!isInside(real, fs.realpathSync(WORKSPACES_ROOT)) || real === fs.realpathSync(WORKSPACES_ROOT)) throw httpError(400, "Not a workspace.");
  try { fs.rmSync(real, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { throw notWritable(e, ws.directory); }
  return ws;
}

/** One folder of the project: sub-folders first, then files, by name. */
export function listFiles(directory: string, sub: unknown): { path: string; entries: ProjectEntry[]; truncated: boolean } {
  const rel = typeof sub === "string" ? sub.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") : "";
  const dir = projectPath(directory, rel, "dir");
  const all = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.name !== ".git");
  const entries: ProjectEntry[] = [];
  for (const d of all.slice(0, MAX_ENTRIES)) {
    const full = P.join(dir, d.name);
    let st: fs.Stats | null = null;
    try { st = fs.statSync(full); } catch { /* broken link */ }
    const type = st?.isDirectory() ? "dir" : "file";
    entries.push({ name: d.name, type, size: type === "file" ? st?.size ?? 0 : 0, modified: st?.mtime.toISOString() ?? null });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { path: rel, entries, truncated: all.length > MAX_ENTRIES };
}

/**
 * Save an uploaded file into a folder of the project. The name is reduced to
 * a bare file name; an existing file is never replaced (name-1.ext, …).
 */
export function saveUpload(directory: string, sub: unknown, name: unknown, bytes: Buffer): { path: string; name: string; bytes: number } {
  const rel = typeof sub === "string" ? sub.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") : "";
  const dir = projectPath(directory, rel, "dir");
  const base = safeName(typeof name === "string" ? name : "");
  const ext = P.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const candidate = P.resolve(dir, i ? `${stem}-${i}${ext}` : base);
    if (!isInside(candidate, dir)) throw httpError(400, "Refusing to write outside the folder.");
    try {
      fs.writeFileSync(candidate, bytes, { flag: "wx" });
      const saved = P.basename(candidate);
      return { path: rel ? `${rel}/${saved}` : saved, name: saved, bytes: bytes.length };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw notWritable(e, dir);
    }
  }
  throw httpError(409, `Too many files called ${base}.`);
}

