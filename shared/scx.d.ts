/**
 * OpenAI-compatible chat shapes shared by the SCX client (server) and the
 * Playground (browser). Types only.
 */

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

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | unknown[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface SCXModel {
  id: string;
  name: string;
  hugging_face_id?: string;
  created: number;
  input_modalities: string[];
  output_modalities: string[];
  quantization?: string;
  context_length: number | null;
  max_output_length: number | null;
  pricing: Record<string, string>;
  supported_sampling_parameters: string[];
  supported_features: string[]; // e.g. "tools", "reasoning", "json_mode"
  description?: string;
  datacenters?: { country_code: string }[];
  /** Which provider serves it; OpenRouter ids are prefixed `openrouter/`. */
  provider?: "scx" | "openrouter";
}
