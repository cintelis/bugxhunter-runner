/**
 * OpenCode bridge.
 * -----------------------------------------------------------------------------
 * Boots one OpenCode server via the official SDK and drives it on behalf of the
 * browser. The SCX provider, its models and the API key come from the user's
 * global OpenCode setup (~/.config/opencode + `opencode auth login`), so
 * BugXHunter and the `opencode` CLI always agree on what's available.
 *
 * Inline config layered on top sets the BugXHunter defaults: GLM-5.3 for both
 * agents and `ask` permissions for edits and shell commands, so every change
 * the build agent makes is approved in the UI rather than running blind.
 *
 * Each request names the project folder it works in; one SDK client is kept
 * per folder.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk";
import type { AgentEvent, AgentModel, MessagePart, StoredMessage } from "../../shared/agent.js";
import { httpError } from "./errors.js";
import { openrouterOpencodeProvider, OPENROUTER_MODELS, PORT } from "./providers.js";

export type { AgentEvent, AgentModel, StoredMessage };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** BugXHunter's own folder: the default project when none is chosen. */
export const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * Remote mode (Docker): OpenCode runs in its own sandboxed container and we
 * talk to it over the network instead of spawning it. Project folders then
 * live in that container, under WORKSPACE_ROOT.
 */
export const REMOTE_URL = process.env.OPENCODE_URL?.replace(/\/$/, "");
export const WORKSPACE_ROOT = process.env.OPEN_RUNNER_WORKSPACE ?? "/workspace";
export const DEFAULT_DIRECTORY = process.env.OPEN_RUNNER_DIR ?? (REMOTE_URL ? WORKSPACE_ROOT : REPO_ROOT);

export const DEFAULT_MODEL = process.env.OPEN_RUNNER_MODEL ?? "scx/GLM-5.3";

/**
 * Config layered on the user's own OpenCode setup. With OPENROUTER_MODELS set,
 * it adds an `openrouter` provider that calls back through this server's
 * key-injecting proxy, so the OpenRouter key stays in the vault.
 */
async function inlineConfig() {
  const openrouter = await openrouterOpencodeProvider(`http://127.0.0.1:${PORT}/openrouter/v1`);
  return {
    model: DEFAULT_MODEL,
    agent: {
      build: { model: DEFAULT_MODEL },
      plan: { model: DEFAULT_MODEL },
    },
    permission: { edit: "ask", bash: "ask" },
    ...(openrouter ? { provider: { openrouter } } : {}),
  };
}

type Client = ReturnType<typeof createOpencodeClient>;

/** Fixed port, so a server orphaned by a hard restart can be found and stopped. */
const AGENT_PORT = Number(process.env.OPEN_RUNNER_AGENT_PORT ?? 8791);

let server: Promise<{ url: string; close(): void }> | null = null;
const clients = new Map<string, Client>();

/** Stop the OpenCode child with us on a clean exit (Ctrl+C). */
let closeServer: (() => void) | null = null;
process.on("exit", () => closeServer?.());
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
  process.on(sig, () => {
    closeServer?.();
    process.exit(0);
  });
}

/**
 * A hard kill of this process (e.g. `tsx watch` restarting on Windows) skips
 * the exit hooks and orphans the OpenCode child on AGENT_PORT. Before booting,
 * stop whatever OpenCode server is still listening there.
 */
async function stopStaleServer() {
  try {
    const r = await fetch(`http://127.0.0.1:${AGENT_PORT}/global/health`, { signal: AbortSignal.timeout(1500) });
    if (!(await r.json())?.healthy) return;
  } catch {
    return; // nothing (or nothing OpenCode) on the port
  }
  for (const pid of listenerPids(AGENT_PORT)) {
    if (!isOpencodeProcess(pid)) continue;
    try {
      process.kill(pid);
      console.log(`  stopped stale OpenCode server (pid ${pid}) on port ${AGENT_PORT}`);
    } catch { /* already gone */ }
  }
  // Give the port a moment to free up.
  for (let i = 0; i < 20; i++) {
    try {
      await fetch(`http://127.0.0.1:${AGENT_PORT}/global/health`, { signal: AbortSignal.timeout(300) });
      await new Promise((r) => setTimeout(r, 150));
    } catch {
      return;
    }
  }
}

function listenerPids(port: number): number[] {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
      return [...new Set(
        out.split(/\r?\n/)
          .map((l) => l.trim().split(/\s+/))
          .filter((c) => c[3] === "LISTENING" && c[1]?.endsWith(`:${port}`))
          .map((c) => Number(c[4])),
      )];
    }
    return execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })
      .split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function isOpencodeProcess(pid: number): boolean {
  try {
    const name = process.platform === "win32"
      ? execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" })
      : execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    return /opencode/i.test(name);
  } catch {
    return false;
  }
}

/** Boot (once) the OpenCode server, or point at the remote one. */
function getServer() {
  if (REMOTE_URL) return Promise.resolve({ url: REMOTE_URL, close() {} });
  if (!server) {
    server = stopStaleServer()
      .then(inlineConfig)
      .then((config) => createOpencodeServer({ hostname: "127.0.0.1", port: AGENT_PORT, timeout: 15000, config: config as any }))
      .then((s) => {
        closeServer = () => {
          try { s.close(); } catch { /* already gone */ }
        };
        console.log(`  OpenCode agent server: ${s.url}`);
        return s;
      })
      .catch((e) => {
        server = null; // allow retry on next request
        throw e;
      });
  }
  return server;
}

export { httpError };
const notFound = (dir: string) => httpError(400, `Folder not found: ${dir}`);

/**
 * Local mode: folders the browser may open, from OPEN_RUNNER_ALLOWED_ROOTS
 * (a PATH-style list). Unset means any folder on this machine, which is fine
 * for a single user on localhost but not once a password + reverse proxy
 * expose the app to others.
 */
export const ALLOWED_ROOTS = (process.env.OPEN_RUNNER_ALLOWED_ROOTS ?? "")
  .split(path.delimiter).map((s) => s.trim()).filter(Boolean).map((r) => path.resolve(r));

const isInside = (abs: string, root: string) => {
  const [a, r] = process.platform === "win32" ? [abs.toLowerCase(), root.toLowerCase()] : [abs, root];
  return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
};

/**
 * Where GitHub clones land (github.ts): `<CLONE_ROOT>/<owner>/<repo>`. In
 * Docker that is the workspace volume, which the agent mounts at the same
 * path. Locally it is OPEN_RUNNER_WORKSPACE, else ~/bugxhunter/repos, and a
 * restricted install (OPEN_RUNNER_ALLOWED_ROOTS) may always open what it cloned.
 */
export const CLONE_ROOT = REMOTE_URL
  ? WORKSPACE_ROOT
  : path.resolve(process.env.OPEN_RUNNER_WORKSPACE ?? path.join(os.homedir(), "bugxhunter", "repos"));
if (!REMOTE_URL && ALLOWED_ROOTS.length && !ALLOWED_ROOTS.some((r) => isInside(CLONE_ROOT, r))) ALLOWED_ROOTS.push(CLONE_ROOT);

/** Normalise and validate a project folder from the browser. */
export async function resolveDirectory(dir?: unknown): Promise<string> {
  const raw = typeof dir === "string" && dir.trim() ? dir.trim() : DEFAULT_DIRECTORY;
  if (REMOTE_URL) {
    // The folder lives in the agent container: keep it inside the workspace
    // and ask OpenCode whether it exists (listing a missing folder fails).
    const abs = path.posix.resolve(WORKSPACE_ROOT, raw.replace(/\\/g, "/"));
    if (abs !== WORKSPACE_ROOT && !abs.startsWith(WORKSPACE_ROOT + "/")) {
      throw httpError(400, `Projects must be inside ${WORKSPACE_ROOT}`);
    }
    const r = await fetch(`${REMOTE_URL}/file?path=.&directory=${encodeURIComponent(abs)}`).catch(() => null);
    if (!r?.ok) throw notFound(abs);
    return abs;
  }
  const abs = path.resolve(raw);
  if (ALLOWED_ROOTS.length && !ALLOWED_ROOTS.some((root) => isInside(abs, root))) {
    throw httpError(400, `Projects must be inside: ${ALLOWED_ROOTS.join(", ")}`);
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw notFound(abs);
  return abs;
}

/** SDK client scoped to one project folder. */
export async function getClient(directory: string): Promise<Client> {
  const { url } = await getServer();
  let c = clients.get(directory);
  if (!c) {
    c = createOpencodeClient({ baseUrl: url, directory });
    clients.set(directory, c);
  }
  return c;
}

export async function serverUrl() {
  return (await getServer()).url;
}

/** Query string from an object, skipping undefined values. */
export function query(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

/**
 * Call an OpenCode route the SDK doesn't wrap (or wraps awkwardly). A non-2xx
 * reply becomes an error carrying the status, which sendError() forwards.
 */
export async function oc<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const r = await fetch(`${await serverUrl()}${path}`, {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(headers as Record<string, string> | undefined) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await r.text().catch(() => "");
  if (!r.ok) throw httpError(r.status, text.slice(0, 500) || `OpenCode replied ${r.status}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** "scx/GLM-5.3" -> { providerID: "scx", modelID: "GLM-5.3" }. */
export function parseModelId(id?: string): { providerID: string; modelID: string } | undefined {
  if (!id) return undefined;
  const i = id.indexOf("/");
  if (i === -1) return undefined;
  return { providerID: id.slice(0, i), modelID: id.slice(i + 1) };
}

/**
 * Every model OpenCode can use, as "provider/model" ids. OpenCode merges our
 * `openrouter` provider with its own catalogue of that provider (hundreds of
 * models, all routed through the proxy); the picker shows only the ids in
 * OPENROUTER_MODELS so it stays usable.
 */
export async function listAgentModels(client: Client): Promise<AgentModel[]> {
  const r: any = await client.config.providers();
  const providers: any[] = r?.data?.providers ?? [];
  const out: AgentModel[] = [];
  const allowed = new Set(OPENROUTER_MODELS);
  for (const p of providers) {
    for (const [mid, m] of Object.entries<any>(p.models ?? {})) {
      if (p.id === "openrouter" && allowed.size && !allowed.has(mid)) continue;
      out.push({
        id: `${p.id}/${mid}`,
        name: m.name ?? mid,
        provider: p.name ?? p.id,
        context: m.limit?.context,
        output: m.limit?.output,
        images: Boolean(m.attachment || m.modalities?.input?.includes?.("image") || m.capabilities?.input?.image),
      });
    }
  }
  return out;
}

/**
 * Collapse a raw OpenCode event into the compact shape the browser renders.
 * Returns null for events the UI doesn't care about.
 */
export function toUiEvent(evt: any): AgentEvent | null {
  const type: string = evt?.type;
  const p = evt?.properties;
  if (!type) return null;
  switch (type) {
    case "message.updated": {
      // Lets the UI attribute text parts (the user's own prompt streams back
      // as a text part too) to the right role.
      const info = p?.info;
      if (!info?.id) return null;
      return {
        kind: "message",
        messageID: info.id,
        role: info.role,
        tokens: info.tokens,
        cost: info.cost,
        model: info.modelID ? `${info.providerID}/${info.modelID}` : undefined,
      };
    }
    case "message.part.updated": {
      const part = p?.part;
      if (!part) return null;
      if (part.type === "text" && part.text) {
        return { kind: "text", messageID: part.messageID, partID: part.id, text: part.text };
      }
      if (part.type === "reasoning" && part.text) {
        return { kind: "reasoning", messageID: part.messageID, partID: part.id, text: part.text };
      }
      if (part.type === "tool") {
        const st = part.state ?? {};
        return {
          kind: "tool",
          messageID: part.messageID,
          callID: part.callID,
          tool: part.tool,
          status: st.status,
          title: st.title,
          input: st.input,
          output: typeof st.output === "string" ? st.output.slice(0, 20000) : undefined,
          error: st.error,
        };
      }
      return null;
    }
    case "permission.updated":
    case "permission.asked": {
      // Older servers put the request in `properties`, newer ones may nest it.
      const perm = p?.id ? p : p?.permission ?? p;
      if (!perm?.id) return null;
      return {
        kind: "permission",
        sessionID: perm.sessionID,
        permissionID: perm.id,
        permType: perm.type ?? (typeof perm.permission === "string" ? perm.permission : undefined),
        title: perm.title,
        pattern: perm.pattern ?? perm.patterns,
        callID: perm.callID ?? perm.tool?.callID,
      };
    }
    case "todo.updated":
      return { kind: "todo", sessionID: p?.sessionID, todos: p?.todos ?? [] };
    case "session.updated": {
      const info = p?.info;
      return info?.id ? { kind: "session", sessionID: info.id, title: info.title } : null;
    }
    case "question.asked":
    case "question.v2.asked": {
      if (!p?.id) return null;
      return {
        kind: "question",
        sessionID: p.sessionID,
        requestID: p.id,
        questions: p.questions ?? [],
        callID: p.tool?.callID,
      };
    }
    case "question.replied":
    case "question.rejected":
    case "question.v2.replied":
    case "question.v2.rejected":
      return { kind: "question-closed", requestID: p?.requestID };
    case "permission.replied":
      return { kind: "permission-replied", permissionID: p?.permissionID ?? p?.requestID ?? p?.id };
    case "session.error":
      return { kind: "error", message: errorText(p?.error) };
    case "session.idle":
      return { kind: "idle", sessionID: p?.sessionID };
    default:
      return null;
  }
}

/**
 * Stored messages (GET /session/:id/message) -> the same shape the browser
 * builds from live events, so a resumed chat renders like a live one.
 */
export function toUiMessages(raw: any[]): StoredMessage[] {
  return raw.map((m) => {
    const info = m.info ?? {};
    const parts: MessagePart[] = [];
    for (const p of m.parts ?? []) {
      if (p.type === "text" && p.text && !p.synthetic) parts.push({ type: "text", id: p.id, text: p.text });
      else if (p.type === "reasoning" && p.text) parts.push({ type: "reasoning", id: p.id, text: p.text });
      else if (p.type === "tool") {
        const st = p.state ?? {};
        parts.push({
          type: "tool", callID: p.callID, tool: p.tool, status: st.status, title: st.title, input: st.input,
          output: typeof st.output === "string" ? st.output.slice(0, 20000) : undefined, error: st.error,
        });
      } else if (p.type === "file") {
        parts.push({
          type: "file", id: p.id, filename: p.filename, mime: p.mime,
          // Keep inline images for thumbnails; drop file:// URLs (meaningless to the browser).
          url: typeof p.url === "string" && p.url.startsWith("data:image/") ? p.url : undefined,
        });
      }
    }
    return {
      id: info.id,
      role: info.role,
      parts,
      tokens: info.tokens,
      cost: info.cost,
      model: info.modelID ? `${info.providerID}/${info.modelID}` : undefined,
      error: info.error ? errorText(info.error) : undefined,
    };
  });
}

/** Pull a readable message out of an OpenCode error payload. */
function errorText(err: any): string {
  const msg = err?.data?.message ?? err?.message ?? err?.name;
  const status = err?.data?.statusCode;
  if (msg) return status ? `${msg} (HTTP ${status})` : String(msg);
  return JSON.stringify(err ?? {}).slice(0, 600);
}
