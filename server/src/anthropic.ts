/**
 * Anthropic (Claude) for the Playground, through the official SDK.
 *
 * The Playground speaks the OpenAI chat shape to every provider. This module turns
 * that request into a Claude Messages request and the answer back into OpenAI-style
 * chunks, so the browser and the /api/chat route need no Claude-specific code.
 * `AnthropicChatClient` has the same `chat` / `chatStreamResponse` surface as
 * `SCXClient`.
 *
 * Claude-specific behaviour:
 *  - Sampling settings (temperature, top_p, penalties, seed) are not sent: current
 *    Claude models reject them.
 *  - Forced tool use ("required" or a named tool) becomes "auto": current models
 *    reject forced tool use.
 *  - Models with safety classifiers that can decline security work get server-side
 *    fallback (`fallbacks: "default"`), so a declined request is re-run on the model
 *    Anthropic recommends for that category instead of just failing. A decline that
 *    still stands is reported as an error that names the category.
 *  - Prompt caching is on (top-level `cache_control`), so a long conversation's
 *    history is not billed in full on every turn.
 *
 * The agent does not use this module: OpenCode talks to Claude natively, through
 * the runner's key-injecting proxy (see index.ts and providers.ts).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ChatCompletion, ChatMessage, ChatParams, SCXModel } from "./scx.js";
import { SCXError } from "./scx.js";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type BlockParam = Anthropic.Beta.BetaContentBlockParam;
type StreamParams = Anthropic.Beta.Messages.MessageCreateParamsStreaming;
type Message = Anthropic.Beta.BetaMessage;

/** Playground ids for Claude models: `anthropic/<model id>`. */
export const ANTHROPIC_PREFIX = "anthropic/";

/** Output budget when the caller sets none (streamed, so a long answer cannot time out). */
const DEFAULT_MAX_TOKENS = 64_000;

/** Models that take server-side fallback in its "default" form. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Image types the Messages API accepts. */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const JSON_ONLY = "Reply with one valid JSON object and nothing else: no prose before or after it, no code fences.";

/** The text of an OpenAI message's content (a string, or the text parts of a part list). */
function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** An OpenAI `image_url` part as a Claude image block, or a note if Claude cannot take it. */
function imageBlock(url: string): BlockParam {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) {
    const media = m[1].toLowerCase();
    if (!IMAGE_TYPES.has(media)) return { type: "text", text: `[An attached ${media} image was not sent: Claude accepts JPEG, PNG, GIF and WebP.]` };
    return { type: "image", source: { type: "base64", media_type: media as "image/png", data: m[2] } };
  }
  if (/^https?:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
  return { type: "text", text: "[An attached image was not sent: unsupported address.]" };
}

/** A user message's content as Claude blocks: text parts and images, empty text dropped. */
function userBlocks(content: ChatMessage["content"]): BlockParam[] {
  if (typeof content === "string") return content.trim() ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: BlockParam[] = [];
  for (const part of content as { type?: string; text?: unknown; image_url?: { url?: string } | string }[]) {
    if (part?.type === "text" && String(part.text ?? "").trim()) out.push({ type: "text", text: String(part.text) });
    else if (part?.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (url) out.push(imageBlock(url));
    }
  }
  return out;
}

/** Tool-call arguments as an object (Claude takes the input parsed; bad JSON becomes {}). */
function parseArgs(args: string): Record<string, unknown> {
  try {
    const v = JSON.parse(args || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * An OpenAI-shaped Playground request as a Claude Messages request.
 * `model` is the bare Claude id; `modelMax` is its output limit, if known.
 */
export function toAnthropicRequest(params: ChatParams, model: string, modelMax?: number | null): StreamParams {
  const system: string[] = [];
  const messages: MessageParam[] = [];
  // Claude wants user and assistant turns to alternate; merge neighbours with the same role.
  const push = (role: "user" | "assistant", blocks: BlockParam[]) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last?.role === role) (last.content as BlockParam[]).push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const m of params.messages) {
    switch (m.role) {
      case "system": {
        const t = textOf(m.content);
        if (t.trim()) system.push(t);
        break;
      }
      case "user":
        push("user", userBlocks(m.content));
        break;
      case "assistant": {
        const blocks: BlockParam[] = [];
        const t = textOf(m.content);
        if (t.trim()) blocks.push({ type: "text", text: t });
        for (const tc of m.tool_calls ?? []) {
          blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
        }
        push("assistant", blocks);
        break;
      }
      case "tool":
        push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: textOf(m.content) || "(no output)" }]);
        break;
    }
  }
  // The conversation must open with a user turn (a Playground chat can open with a greeting).
  if (messages[0]?.role === "assistant") messages.unshift({ role: "user", content: [{ type: "text", text: "(conversation start)" }] });
  if (params.response_format?.type === "json_object") system.push(JSON_ONLY);

  const tools = params.tools?.map((t) => ({
    name: t.function.name,
    ...(t.function.description ? { description: t.function.description } : {}),
    input_schema: { type: "object" as const, ...(t.function.parameters ?? {}) },
  }));
  const stops = (Array.isArray(params.stop) ? params.stop : params.stop ? [params.stop] : []).filter((s) => typeof s === "string" && s.trim());
  const cap = modelMax && modelMax > 0 ? modelMax : 128_000;
  const maxTokens = Math.max(1, Math.min(params.max_tokens && params.max_tokens > 0 ? params.max_tokens : DEFAULT_MAX_TOKENS, cap));

  return {
    model,
    max_tokens: maxTokens,
    messages,
    stream: true,
    cache_control: { type: "ephemeral" },
    ...(system.length ? { system: system.join("\n\n") } : {}),
    ...(tools?.length ? { tools, tool_choice: params.tool_choice === "none" ? { type: "none" as const } : { type: "auto" as const } } : {}),
    ...(stops.length ? { stop_sequences: stops } : {}),
    ...(FALLBACK_MODELS.has(model) ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
  };
}

/** Claude's stop reason as an OpenAI finish reason. */
export function finishReason(stop: string | null | undefined): string | null {
  switch (stop) {
    case "end_turn": case "stop_sequence": case "pause_turn": return "stop";
    case "max_tokens": case "model_context_window_exceeded": return "length";
    case "tool_use": return "tool_calls";
    case "refusal": return "content_filter";
    default: return stop ?? null;
  }
}

/** The error to show when Claude (and any fallback) declined the request. */
export function refusalMessage(msg: Pick<Message, "stop_details">): string {
  const details = msg.stop_details as { category?: string | null; explanation?: string | null } | null | undefined;
  const cat = details?.category;
  const why = details?.explanation ? ` ${details.explanation}` : "";
  const cyber = cat === "cyber"
    ? " For authorised security work, Anthropic's Cyber Verification Program can lift this: https://support.claude.com/en/articles/14604842-real-time-cyber-safeguards-on-claude-opus-and-sonnet"
    : "";
  return `Claude declined this request${cat ? ` (safety category: ${cat})` : ""}.${why} Rephrase it, or try another model.${cyber}`;
}

/** The blocks after the last fallback marker: what the model that finished the turn wrote. */
function servedBlocks(msg: Message) {
  const content = msg.content;
  let start = 0;
  content.forEach((b, i) => { if ((b.type as string) === "fallback") start = i + 1; });
  return { all: content, served: content.slice(start) };
}

/** Text of the whole turn (text before a mid-answer fallback is the start the fallback continued). */
const turnText = (msg: Message) =>
  servedBlocks(msg).all.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");

/** Tool calls from the model that finished the turn, in OpenAI form. */
function turnToolCalls(msg: Message) {
  return servedBlocks(msg).served
    .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
    .map((t) => ({ id: t.id, type: "function" as const, function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } }));
}

function usageOf(u: Message["usage"]) {
  const prompt = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return { prompt_tokens: prompt, completion_tokens: u.output_tokens ?? 0, total_tokens: prompt + (u.output_tokens ?? 0) };
}

/** An SDK error as an SCXError the routes already know how to report. */
export function toSCXError(e: unknown): unknown {
  if (e instanceof Anthropic.APIError) {
    const body = (e as { error?: { error?: { message?: string; type?: string } } }).error;
    const message = body?.error?.message ?? e.message;
    if (e.status === 401 || e.status === 403) {
      return new SCXError(502, `Anthropic rejected the API key (${e.status}: ${message}). Check ANTHROPIC_API_KEY in the vault.`, body?.error?.type);
    }
    if (e instanceof Anthropic.APIConnectionError) return new SCXError(502, `Could not reach Anthropic: ${message}`, "connection");
    return new SCXError(e.status ?? 502, message, body?.error?.type);
  }
  return e;
}

export interface AnthropicChatOptions {
  apiKey: () => string;
  baseUrl?: string;
  /** Output limit of a model, if known (caps max_tokens). */
  maxOutput?: (model: string) => number | null | undefined;
  /** For tests: the fetch the SDK uses. */
  fetch?: typeof fetch;
}

/** Claude behind the same surface as SCXClient: `chat` and `chatStreamResponse`. */
export class AnthropicChatClient {
  constructor(private readonly opts: AnthropicChatOptions) {}

  /** A fresh SDK client per call: the key comes from the vault and can change. */
  private client(): Anthropic {
    return new Anthropic({
      apiKey: this.opts.apiKey(),
      ...(this.opts.baseUrl ? { baseURL: this.opts.baseUrl } : {}),
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
    });
  }

  /** Start a streamed request; resolves once Claude has answered (so HTTP errors throw here). */
  private async start(params: ChatParams) {
    const req = toAnthropicRequest(params, params.model, this.opts.maxOutput?.(params.model));
    const stream = this.client().beta.messages.stream(req);
    try {
      await stream.withResponse();
    } catch (e) {
      throw toSCXError(e);
    }
    return stream;
  }

  /** One whole completion (streamed underneath, so a long answer cannot hit a request timeout). */
  async chat(params: ChatParams): Promise<ChatCompletion> {
    const stream = await this.start(params);
    let msg: Message;
    try {
      msg = await stream.finalMessage();
    } catch (e) {
      throw toSCXError(e);
    }
    if (msg.stop_reason === "refusal") throw new SCXError(422, refusalMessage(msg), "refusal");
    const calls = turnToolCalls(msg);
    return {
      id: msg.id,
      model: msg.model,
      created: Math.floor(Date.now() / 1000),
      choices: [{
        index: 0,
        finish_reason: finishReason(msg.stop_reason),
        message: { role: "assistant", content: turnText(msg), ...(calls.length ? { tool_calls: calls } : {}) },
      }],
      usage: usageOf(msg.usage),
    };
  }

  /**
   * A streamed completion as an OpenAI-style SSE Response. Text streams as it is
   * written; tool calls are sent once the turn is complete, so calls from a model
   * that was declined mid-answer (and replaced by a fallback) never reach the browser.
   */
  async chatStreamResponse(params: ChatParams): Promise<Response> {
    const stream = await this.start(params);
    const enc = new TextEncoder();
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
      enc.encode(`data: ${JSON.stringify({ id: "", object: "chat.completion.chunk", created, model: params.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);

    async function* events(): AsyncGenerator<Uint8Array> {
      try {
        for await (const ev of stream) {
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta" && ev.delta.text) yield chunk({ content: ev.delta.text });
        }
        const msg = await stream.finalMessage();
        if (msg.stop_reason === "refusal") throw new SCXError(422, refusalMessage(msg), "refusal");
        const calls = turnToolCalls(msg);
        if (calls.length) yield chunk({ tool_calls: calls.map((c, index) => ({ index, ...c })) });
        yield chunk({}, finishReason(msg.stop_reason), { usage: usageOf(msg.usage) });
        yield enc.encode("data: [DONE]\n\n");
      } catch (e) {
        throw toSCXError(e);
      } finally {
        if (!stream.ended) stream.abort(); // the browser went away mid-answer: stop the upstream request
      }
    }
    const it = events();
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const { value, done } = await it.next();
        if (done) ctrl.close();
        else ctrl.enqueue(value);
      },
      async cancel() {
        if (!stream.ended) stream.abort(); // now, not after the generator's pending read
        await it.return(undefined).catch(() => {});
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  }
}

/** A Claude model from the Models API, in the shape the Playground understands. */
export function normaliseAnthropic(m: Anthropic.ModelInfo): SCXModel {
  const images = m.capabilities?.image_input?.supported ?? true;
  return {
    id: `${ANTHROPIC_PREFIX}${m.id}`,
    name: m.display_name || m.id,
    created: Math.floor(Date.parse(m.created_at) / 1000) || 0,
    input_modalities: images ? ["text", "image"] : ["text"],
    output_modalities: ["text"],
    context_length: m.max_input_tokens,
    max_output_length: m.max_tokens,
    pricing: {},
    supported_sampling_parameters: ["max_tokens", "stop"],
    supported_features: ["tools", "json_mode", "reasoning"],
    description: m.lifecycle === "deprecated" ? "Anthropic Claude model (deprecated: still served, being retired)." : "Anthropic Claude model.",
    provider: "anthropic",
  };
}

/** The Claude models the key can use (active and deprecated; retired ones are gone). */
export async function listAnthropicModels(apiKey: string, baseUrl?: string): Promise<Anthropic.ModelInfo[]> {
  const client = new Anthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}), timeout: 10_000, maxRetries: 1 });
  const out: Anthropic.ModelInfo[] = [];
  for await (const m of client.models.list({ limit: 100 })) if (m.lifecycle !== "retired") out.push(m);
  return out;
}
