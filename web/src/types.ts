import type { ToolDef as WireToolDef } from "../../shared/scx";

export type { SCXModel, ToolCall } from "../../shared/scx";

export interface RagSource {
  doc: string;
  score: number;
}

/** A tool definition as edited in the Playground: the wire shape plus a UI-only key. */
export interface ToolDef extends WireToolDef {
  /** UI-only stable key for the editor (see tools.ts); stripped before sending. */
  id?: string;
}

/** An image attached to a Playground user turn, held as a data: URL. */
export interface ChatImage {
  name: string;
  url: string;
}

/** A draw.io diagram attached to a Playground user turn, sent as a text outline (see wire.ts). */
export interface ChatDoc {
  name: string;
  /** The outline the render service made from the file. */
  text: string;
  pages?: string[];
}

export interface ChatMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Images sent with a user turn (vision models only); sent as image_url parts. */
  images?: ChatImage[];
  /** draw.io diagrams sent with a user turn, as outlines appended to the text. */
  docs?: ChatDoc[];
  tool_calls?: import("../../shared/scx").ToolCall[];
  tool_call_id?: string;
  /** UI-only: live token usage attached to assistant turns. */
  usage?: { prompt?: number; completion?: number; reasoning?: number };
  /** UI-only: timings for an assistant turn, in ms (ttft = time to first token). */
  timing?: { ttft?: number; total: number };
  /** UI-only: RAG sources retrieved for this turn. */
  sources?: RagSource[];
}

export interface KBDoc {
  id: string;
  name: string;
  chunks: number;
  chars: number;
}

/** A saved bot design. */
export interface BotConfig {
  name: string;
  model: string;
  system: string;
  temperature: number;
  maxTokens: number;
  topP: number;
  jsonMode: boolean;
  stream: boolean;
  tools: ToolDef[];
  /** Ground answers in the knowledge base (RAG). */
  useKnowledge: boolean;
  /** Speak assistant replies aloud (browser TTS). */
  speak: boolean;
  /** Save Playground chats to the runner, sealed with the vault key. */
  saveSessions: boolean;
}
