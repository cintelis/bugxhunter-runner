/**
 * Client for the OpenCode agent (server routes under /api/agent/*).
 * The build agent reads/writes files and runs commands in the chosen project
 * folder, so the UI streams its work live and gates edits through the
 * permission flow.
 */

import type {
  AgentEvent, AgentModel, AgentQuestion, AgentStatus, FileDiff, PendingRequests, SessionSummary, SlashCommand,
  StoredMessage, Todo, Tokens,
} from "../../shared/agent";
export type { AgentEvent, AgentModel, AgentQuestion, AgentStatus, FileDiff, PendingRequests, SessionSummary, SlashCommand, StoredMessage, Todo, Tokens };

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
): Promise<PendingRequests> {
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

export async function agentDiff(sessionID: string, directory: string): Promise<unknown> {
  const r = await fetch(
    `/api/agent/diff?sessionID=${encodeURIComponent(sessionID)}&directory=${encodeURIComponent(directory)}`,
  );
  return r.ok ? (await r.json()).diff : null;
}

/**
 * Follow the SSE event stream for a session and dispatch parsed events until
 * the signal aborts. A dropped connection (proxy idle timeout, backend
 * restart) is reconnected with backoff; `onReconnect` fires after each
 * reconnect so the caller can catch up on anything missed meanwhile. An HTTP
 * error on connect (bad folder, signed out) is not retried: it throws.
 */
export async function openAgentEvents(
  sessionID: string,
  directory: string,
  onEvent: (e: AgentEvent) => void,
  signal: AbortSignal,
  onReconnect?: () => void,
): Promise<void> {
  let delay = 1000;
  let connected = false;
  while (!signal.aborted) {
    try {
      await readAgentEvents(sessionID, directory, onEvent, signal, () => {
        delay = 1000;
        if (connected) onReconnect?.();
        connected = true;
      });
    } catch (e) {
      if (signal.aborted) return;
      if ((e as { fatal?: boolean }).fatal) throw e;
      // network drop: fall through and retry
    }
    if (signal.aborted) return;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 10_000);
  }
}

/** One connection: resolves when the server ends the stream, rejects on a drop. */
async function readAgentEvents(
  sessionID: string,
  directory: string,
  onEvent: (e: AgentEvent) => void,
  signal: AbortSignal,
  onOpen: () => void,
): Promise<void> {
  const r = await fetch(
    `/api/agent/events?sessionID=${encodeURIComponent(sessionID)}&directory=${encodeURIComponent(directory)}`,
    { signal },
  );
  if (!r.ok || !r.body) {
    throw Object.assign(new Error((await errMsg(r)) || `Event stream failed (${r.status})`), { fatal: true });
  }
  onOpen();
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
