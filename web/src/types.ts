export interface SCXModel {
  id: string;
  name: string;
  context_length: number | null;
  max_output_length: number | null;
  input_modalities: string[];
  output_modalities: string[];
  supported_features: string[];
  supported_sampling_parameters: string[];
  pricing: Record<string, string>;
  description?: string;
  datacenters?: { country_code: string }[];
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface RagSource {
  doc: string;
  score: number;
}

export interface ChatMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
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
