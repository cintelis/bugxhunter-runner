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

export interface ChatMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: import("../../shared/scx").ToolCall[];
  tool_call_id?: string;
  /** UI-only: live token usage attached to assistant turns. */
  usage?: { prompt?: number; completion?: number; reasoning?: number };
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
}
