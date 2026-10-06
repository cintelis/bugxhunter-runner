/**
 * Client for the OpenCode agent (server routes under /api/agent/*).
 * The build agent reads/writes files and runs commands in the chosen project
 * folder, so the UI streams its work live and gates edits through the
 * permission flow.
 */

export interface AgentModel {
  id: string;
  name: string;
  provider: string;
  context?: number;
  output?: number;
  /** Accepts image input. */
  images?: boolean;
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled" | string;
  priority?: string;
}

export interface SessionSummary {
  id: string;
  title?: string;
  created?: number;
  updated?: number;
  files: number;
  additions: number;
  deletions: number;
}

/** A message as stored by OpenCode, already mapped to the UI's part shapes. */
export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  parts: Record<string, any>[];
  tokens?: Tokens;
  cost?: number;
  model?: string;
  error?: string;
}

export interface SlashCommand {
  name: string;
  description: string;
  hint: string;
}

export interface FileUpload {
  name: string;
  mime: string;
  /** Base64 contents. */
  data: string;
  size: number;
  /** data: URL for image thumbnails. */
  preview?: string;
}

export async function agentSessions(directory: string): Promise<SessionSummary[]> {
  const r = await fetch(`/api/agent/sessions?directory=${encodeURIComponent(directory)}`);
  if (!r.ok) throw new Error((await errMsg(r)) || `Could not list sessions (${r.status})`);
  return (await r.json()).sessions;
}

export async function agentLoadSession(id: string, directory: string): Promise<{ messages: StoredMessage[]; todos: Todo[] }> {
  const r = await fetch(`/api/agent/session/${encodeURIComponent(id)}/messages?directory=${encodeURIComponent(directory)}`);
  if (!r.ok) throw new Error((await errMsg(r)) || `Could not load session (${r.status})`);
  return r.json();
}

export async function agentDeleteSession(id: string, directory: string): Promise<void> {
  const r = await fetch(`/api/agent/session/${encodeURIComponent(id)}?directory=${encodeURIComponent(directory)}`, { method: "DELETE" });
  if (!r.ok) throw new Error((await errMsg(r)) || `Could not delete session (${r.status})`);
}

export async function agentCommands(directory: string): Promise<SlashCommand[]> {
  const r = await fetch(`/api/agent/commands?directory=${encodeURIComponent(directory)}`);
  return r.ok ? (await r.json()).commands : [];
}

export async function agentRunCommand(body: {
  sessionID: string; command: string; arguments: string; agent: string; model?: string; directory: string;
}): Promise<void> {
  const r = await fetch("/api/agent/command", { method: "POST", headers: json(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await errMsg(r)) || `Command failed (${r.status})`);
}

export async function agentCompact(sessionID: string, directory: string, model?: string): Promise<void> {
  const r = await fetch("/api/agent/compact", { method: "POST", headers: json(), body: JSON.stringify({ sessionID, directory, model }) });
  if (!r.ok) throw new Error((await errMsg(r)) || `Compact failed (${r.status})`);
}

export interface AgentStatus {
  ready: boolean;
  url: string;
  directory: string;
  defaultModel: string;
  models: AgentModel[];
}

export interface Tokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/** Compact events emitted by GET /api/agent/events (see server/opencode.ts). */
export type AgentEvent =
  | { kind: "open" }
  | { kind: "message"; messageID: string; role: "user" | "assistant" | string; tokens?: Tokens; cost?: number; model?: string }
  | { kind: "text"; messageID: string; partID?: string; text: string }
  | { kind: "reasoning"; messageID: string; partID?: string; text: string }
  | {
      kind: "tool";
      messageID: string;
      callID: string;
      tool: string;
      status: "pending" | "running" | "completed" | "error" | string;
      title?: string;
      input?: Record<string, unknown>;
      output?: string;
      error?: string;
    }
  | {
      kind: "permission";
      sessionID: string;
      permissionID: string;
      permType?: string;
      title?: string;
      pattern?: string | string[];
      callID?: string;
    }
  | { kind: "permission-replied"; permissionID: string }
  | { kind: "todo"; sessionID?: string; todos: Todo[] }
  | { kind: "session"; sessionID: string; title?: string }
  | { kind: "question"; sessionID: string; requestID: string; questions: AgentQuestion[]; callID?: string }
  | { kind: "question-closed"; requestID: string }
  | { kind: "idle"; sessionID?: string }
  | { kind: "error"; message: string };

export async function agentStatus(): Promise<AgentStatus> {
  const r = await fetch("/api/agent/status");
  if (!r.ok) throw new Error((await errMsg(r)) || `Agent server not ready (${r.status})`);
  return r.json();
}

/** Resolve a folder path on the server; throws if it doesn't exist. */
export async function agentCheckDirectory(directory: string): Promise<string> {
  const r = await fetch(`/api/agent/directory?directory=${encodeURIComponent(directory)}`);
  if (!r.ok) throw new Error((await errMsg(r)) || `Folder not found (${r.status})`);
  return (await r.json()).directory;
}

/** Approvals + questions already waiting on a session (so reloads restore them). */
export async function agentPending(
  sessionID: string,
  directory: string,
): Promise<{ permissions: Extract<AgentEvent, { kind: "permission" }>[]; questions: Extract<AgentEvent, { kind: "question" }>[] }> {
  const r = await fetch(`/api/agent/pending?sessionID=${encodeURIComponent(sessionID)}&directory=${encodeURIComponent(directory)}`);
  if (!r.ok) return { permissions: [], questions: [] };
  return r.json();
}

export async function agentCreateSession(directory: string): Promise<{ id: string; directory: string }> {
  const r = await fetch("/api/agent/session", { method: "POST", headers: json(), body: JSON.stringify({ directory }) });
  if (!r.ok) throw new Error((await errMsg(r)) || `Could not create session (${r.status})`);
  return r.json();
}

export async function agentPrompt(body: {
  sessionID: string;
  text: string;
  agent: string;
  model?: string;
  directory: string;
  files?: { name: string; mime: string; data: string }[];
  /** Send images to the model itself (only for models that accept images). */
  inlineImages?: boolean;
}): Promise<void> {
  const r = await fetch("/api/agent/prompt", { method: "POST", headers: json(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await errMsg(r)) || `Prompt failed (${r.status})`);
}

export async function agentReplyPermission(body: {
  sessionID: string;
  permissionID: string;
  response: "once" | "always" | "reject";
  directory: string;
}): Promise<void> {
  const r = await fetch("/api/agent/permission", { method: "POST", headers: json(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await errMsg(r)) || `Permission reply failed (${r.status})`);
}

export interface AgentQuestion {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  /** Allow picking several options. */
  multiple?: boolean;
  /** Allow a typed answer (default true). */
  custom?: boolean;
}

/** Answer a question (one array of labels/text per question), or dismiss it. */
export async function agentAnswerQuestion(body: {
  requestID: string;
  directory: string;
  answers?: string[][];
  reject?: boolean;
}): Promise<void> {
  const r = await fetch("/api/agent/question", { method: "POST", headers: json(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await errMsg(r)) || `Answer failed (${r.status})`);
}

export async function agentAbort(sessionID: string, directory: string): Promise<void> {
  await fetch("/api/agent/abort", { method: "POST", headers: json(), body: JSON.stringify({ sessionID, directory }) });
}

export interface FileDiff {
  file: string;
  /** Unified patch (current OpenCode) … */
  patch?: string;
  /** … or full before/after text (older OpenCode). */
  before?: string;
  after?: string;
  additions?: number;
  deletions?: number;
  status?: string;
  /** Which prompt in the session made the change (1-based). */
  turn?: number;
}

export async function agentDiff(sessionID: string, directory: string): Promise<unknown> {
  const r = await fetch(
    `/api/agent/diff?sessionID=${encodeURIComponent(sessionID)}&directory=${encodeURIComponent(directory)}`,
  );
  return r.ok ? (await r.json()).diff : null;
}

/**
 * Open the SSE event stream for a session and dispatch parsed events.
 * Returns nothing; pass an AbortSignal to close it.
 */
export async function openAgentEvents(
  sessionID: string,
  directory: string,
  onEvent: (e: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const r = await fetch(
    `/api/agent/events?sessionID=${encodeURIComponent(sessionID)}&directory=${encodeURIComponent(directory)}`,
    { signal },
  );
  if (!r.ok || !r.body) throw new Error(`Event stream failed (${r.status})`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as AgentEvent);
      } catch {
        /* ignore keep-alives / partials */
      }
    }
  }
}

const json = () => ({ "Content-Type": "application/json" });
async function errMsg(r: Response): Promise<string> {
  try {
    return (await r.json())?.error?.message ?? "";
  } catch {
    return "";
  }
}
