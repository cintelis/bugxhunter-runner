/**
 * SCX Platform client wrapper
 * -----------------------------------------------------------------------------
 * A small, dependency-free TypeScript client for the SCX API (https://api.scx.ai/v1).
 * SCX is OpenAI-compatible and additionally exposes the OpenAI "Responses" API,
 * an Anthropic-compatible "Messages" API, Batches, embeddings and audio.
 *
 * Auth: pass your `sk-scx-...` key; sent as `Authorization: Bearer <key>`.
 * Errors: non-2xx responses throw `SCXError` with the HTTP status and the
 * parsed provider message (so tier/rate-limit `429`s surface cleanly).
 */

export const SCX_DEFAULT_BASE_URL = "https://api.scx.ai/v1";

export class SCXError extends Error {
  constructor(
    public status: number,
    message: string,
    public type?: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "SCXError";
  }
}

// ---------------------------------------------------------------------------
// Types (a pragmatic subset of the OpenAI/Anthropic-compatible shapes)
// ---------------------------------------------------------------------------

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
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | unknown[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
  tools?: ToolDef[];
  tool_choice?: "auto" | "none" | "required" | Record<string, unknown>;
  response_format?: { type: "text" | "json_object" };
  stream?: boolean;
  [key: string]: unknown;
}

export interface ChatCompletion {
  id: string;
  model: string;
  created: number;
  choices: {
    index: number;
    finish_reason: string | null;
    message: ChatMessage;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface SCXClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Per-request timeout in ms (default 120s). */
  timeoutMs?: number;
}

export class SCXClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(opts: SCXClientOptions) {
    if (!opts.apiKey) throw new Error("SCXClient: apiKey is required");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? SCX_DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /** Low-level fetch that injects auth, JSON headers, and a timeout. */
  private async request(
    path: string,
    init: RequestInit & { json?: unknown } = {},
  ): Promise<Response> {
    const { json, headers, ...rest } = init;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...rest,
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: json !== undefined ? JSON.stringify(json) : rest.body,
      });
    } finally {
      clearTimeout(t);
    }
  }

  /** Parse a non-2xx response into a typed SCXError. */
  private async toError(res: Response): Promise<SCXError> {
    let body: unknown;
    let message = `${res.status} ${res.statusText}`;
    let type: string | undefined;
    try {
      body = await res.json();
      const err = (body as any)?.error ?? body;
      if (err?.message) message = err.message;
      type = err?.type;
    } catch {
      try {
        message = (await res.text()) || message;
      } catch {
        /* ignore */
      }
    }
    return new SCXError(res.status, message, type, body);
  }

  private async json<T>(res: Response): Promise<T> {
    if (!res.ok) throw await this.toError(res);
    return (await res.json()) as T;
  }

  // --- Models ---------------------------------------------------------------

  async listModels(): Promise<SCXModel[]> {
    const res = await this.request("/models", { method: "GET" });
    const data = await this.json<{ data: SCXModel[] }>(res);
    return data.data;
  }

  // --- Chat Completions -----------------------------------------------------

  async chat(params: ChatParams): Promise<ChatCompletion> {
    const res = await this.request("/chat/completions", {
      method: "POST",
      json: { ...params, stream: false },
    });
    return this.json<ChatCompletion>(res);
  }

  /**
   * Streaming chat. Returns the raw `Response` so callers can pipe the SSE
   * body straight through (e.g. an Express proxy). Use `streamChat` for an
   * async iterator of parsed text deltas.
   */
  async chatStreamResponse(params: ChatParams): Promise<Response> {
    const res = await this.request("/chat/completions", {
      method: "POST",
      json: { ...params, stream: true },
    });
    if (!res.ok) throw await this.toError(res);
    return res;
  }

  /** Async generator yielding incremental content + tool-call deltas. */
  async *streamChat(
    params: ChatParams,
  ): AsyncGenerator<{ content?: string; finish_reason?: string; raw: any }> {
    const res = await this.chatStreamResponse(params);
    for await (const evt of parseSSE(res)) {
      if (evt === "[DONE]") return;
      let data: any;
      try {
        data = JSON.parse(evt);
      } catch {
        continue;
      }
      const choice = data.choices?.[0];
      yield {
        content: choice?.delta?.content ?? undefined,
        finish_reason: choice?.finish_reason ?? undefined,
        raw: data,
      };
    }
  }

  // --- Embeddings -----------------------------------------------------------

  async embeddings(params: {
    model: string;
    input: string | string[];
  }): Promise<{ data: { embedding: number[]; index: number }[]; usage?: any }> {
    const res = await this.request("/embeddings", { method: "POST", json: params });
    return this.json(res);
  }

  // --- OpenAI "Responses" API ----------------------------------------------

  async responses(params: {
    model: string;
    input: string | unknown[];
    max_output_tokens?: number;
    [key: string]: unknown;
  }): Promise<any> {
    const res = await this.request("/responses", { method: "POST", json: params });
    return this.json(res);
  }

  // --- Anthropic-compatible "Messages" API ----------------------------------

  async messages(params: {
    model: string;
    max_tokens: number;
    messages: { role: "user" | "assistant"; content: unknown }[];
    system?: string;
    [key: string]: unknown;
  }): Promise<any> {
    const res = await this.request("/messages", { method: "POST", json: params });
    return this.json(res);
  }

  // --- Batches --------------------------------------------------------------

  async listBatches(): Promise<{ object: string; data: any[]; has_more: boolean }> {
    const res = await this.request("/batches", { method: "GET" });
    return this.json(res);
  }
}

// ---------------------------------------------------------------------------
// SSE parsing helper (works on any fetch Response with a text/event-stream body)
// ---------------------------------------------------------------------------

export async function* parseSSE(res: Response): AsyncGenerator<string> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    // SSE events are separated by a blank line; data lines begin with "data: "
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}
