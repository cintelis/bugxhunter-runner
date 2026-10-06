import type { SCXModel, ChatMsg, ToolDef, ToolCall, KBDoc, RagSource } from "./types";

/** Fetch the model catalogue (with capabilities) from the proxy. */
export async function fetchModels(): Promise<SCXModel[]> {
  const r = await fetch("/api/models");
  if (!r.ok) throw new Error((await safeErr(r)) || `Failed to load models (${r.status})`);
  const j = await r.json();
  return j.data as SCXModel[];
}

// --- Knowledge base (RAG) ---------------------------------------------------

export async function kbList(): Promise<KBDoc[]> {
  const r = await fetch("/api/kb");
  return r.ok ? (await r.json()).docs : [];
}
export async function kbAdd(name: string, text: string): Promise<KBDoc[]> {
  const r = await fetch("/api/kb", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, text }),
  });
  if (!r.ok) throw new Error((await safeErr(r)) || `Failed to add document (${r.status})`);
  return (await r.json()).docs as KBDoc[];
}
export async function kbDelete(id: string): Promise<KBDoc[]> {
  const r = await fetch(`/api/kb/${id}`, { method: "DELETE" });
  return r.ok ? (await r.json()).docs : [];
}

export interface ChatRequest {
  model: string;
  messages: { role: string; content: unknown; tool_calls?: ToolCall[]; tool_call_id?: string }[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: ToolDef[];
  response_format?: { type: "json_object" | "text" };
  rag?: boolean;
  ragTopK?: number;
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onToolCalls?: (calls: ToolCall[]) => void;
  onUsage?: (u: ChatMsg["usage"]) => void;
  onSources?: (s: RagSource[]) => void;
  onDone: (finishReason: string | null) => void;
  onError: (message: string) => void;
  signal?: AbortSignal;
}

/** Streaming chat over SSE via the proxy. */
export async function streamChat(req: ChatRequest, h: StreamHandlers): Promise<void> {
  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...req, stream: true }),
    signal: h.signal,
  });
  if (!r.ok || !r.body) {
    h.onError((await safeErr(r)) || `Chat request failed (${r.status})`);
    return;
  }

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  // Tool-call deltas arrive fragmented across chunks; accumulate by index.
  const toolAcc: Record<number, ToolCall> = {};
  let finish: string | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        flushTools(toolAcc, h);
        h.onDone(finish);
        return;
      }
      let data: any;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }
      if (data.error) {
        h.onError(data.error.message ?? "stream error");
        return;
      }
      if (data.scx_sources) {
        h.onSources?.(data.scx_sources as RagSource[]);
        continue;
      }
      const choice = data.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content) h.onDelta(delta.content);
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          toolAcc[i] ??= { id: tc.id ?? `call_${i}`, type: "function", function: { name: "", arguments: "" } };
          if (tc.id) toolAcc[i].id = tc.id;
          if (tc.function?.name) toolAcc[i].function.name += tc.function.name;
          if (tc.function?.arguments) toolAcc[i].function.arguments += tc.function.arguments;
        }
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (data.usage) {
        h.onUsage?.({
          prompt: data.usage.prompt_tokens,
          completion: data.usage.completion_tokens,
          reasoning: data.usage.completion_tokens_details?.reasoning_tokens,
        });
      }
    }
  }
  flushTools(toolAcc, h);
  h.onDone(finish);
}

function flushTools(acc: Record<number, ToolCall>, h: StreamHandlers) {
  const calls = Object.values(acc).filter((c) => c.function.name);
  if (calls.length && h.onToolCalls) h.onToolCalls(calls);
}

async function safeErr(r: Response): Promise<string> {
  try {
    const j = await r.json();
    return j?.error?.message ?? "";
  } catch {
    return "";
  }
}
