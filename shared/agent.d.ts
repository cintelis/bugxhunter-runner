/**
 * The contract between the server's OpenCode bridge and the browser.
 *
 * Types only (a .d.ts), so both workspaces can `import type` it without a
 * build step or runtime dependency: `server/src/opencode.ts` must produce
 * these shapes and `web/src/agentApi.ts` consumes them, so a change on one
 * side fails the other side's type-check.
 */

export interface Tokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled" | string;
  priority?: string;
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

/** A model OpenCode can use, as "provider/model". */
export interface AgentModel {
  id: string;
  name: string;
  provider: string;
  context?: number;
  output?: number;
  /** Accepts image input. */
  images?: boolean;
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

export interface SlashCommand {
  name: string;
  description: string;
  hint: string;
}

/** Per-file change recorded by OpenCode for a session. */
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

// --- Transcript parts (stored messages and live events share these) ---------

export interface TextPart { type: "text"; id: string; text: string }
export interface ReasoningPart { type: "reasoning"; id: string; text: string }
export interface ToolPart {
  type: "tool";
  callID: string;
  tool: string;
  /** "interrupted": left running by a turn that was cut off; nothing will complete it. */
  status: "pending" | "running" | "completed" | "error" | "interrupted" | string;
  title?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}
export interface FilePart {
  type: "file";
  id: string;
  filename?: string;
  mime?: string;
  /** Inline image (data: URL) for a thumbnail. */
  url?: string;
  size?: number;
}
export type MessagePart = TextPart | ReasoningPart | ToolPart | FilePart;

/** A message as stored by OpenCode, mapped to the browser's part shapes. */
export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  tokens?: Tokens;
  cost?: number;
  model?: string;
  error?: string;
  /** Set when a subagent (task tool) produced it: that session's title. */
  subagent?: string;
}

// --- Live events (GET /api/agent/events) -------------------------------------

export interface PermissionRequest {
  kind: "permission";
  sessionID: string;
  permissionID: string;
  permType?: string;
  title?: string;
  pattern?: string | string[];
  callID?: string;
  /** Raised by a subagent of the chat's session: that session's title. */
  subagent?: string;
}

export interface QuestionRequest {
  kind: "question";
  sessionID: string;
  requestID: string;
  questions: AgentQuestion[];
  callID?: string;
  subagent?: string;
}

/**
 * Live events. Anything a subagent session produces (the task tool spawns one
 * per delegation) is relayed with `subagent` set to that session's title, so
 * the browser can show it under the parent chat and answer its prompts.
 */
export type AgentEvent = AgentEventBase & { subagent?: string };

type AgentEventBase =
  | { kind: "open" }
  | { kind: "message"; messageID: string; role: "user" | "assistant" | string; tokens?: Tokens; cost?: number; model?: string }
  | { kind: "text"; messageID: string; partID?: string; text: string }
  | { kind: "reasoning"; messageID: string; partID?: string; text: string }
  | (Omit<ToolPart, "type"> & { kind: "tool"; messageID: string })
  | PermissionRequest
  | { kind: "permission-replied"; permissionID: string }
  | { kind: "todo"; sessionID?: string; todos: Todo[] }
  | { kind: "session"; sessionID: string; title?: string }
  | QuestionRequest
  | { kind: "question-closed"; requestID: string }
  | { kind: "idle"; sessionID?: string }
  | { kind: "error"; message: string };

/** GET /api/agent/pending */
export interface PendingRequests {
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
}

/** GET /api/agent/status */
export interface AgentStatus {
  ready: boolean;
  url: string;
  directory: string;
  defaultModel: string;
  models: AgentModel[];
}
