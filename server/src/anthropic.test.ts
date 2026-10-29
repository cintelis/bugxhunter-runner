import { describe, expect, it } from "vitest";
import { AnthropicChatClient, finishReason, normaliseAnthropic, refusalMessage, toAnthropicRequest } from "./anthropic.js";
import { SCXError, type ChatParams } from "./scx.js";

describe("toAnthropicRequest", () => {
  it("moves system text to the top level and drops sampling settings", () => {
    const req = toAnthropicRequest({
      model: "x",
      temperature: 0.2, top_p: 0.9, seed: 1, presence_penalty: 0.5,
      messages: [
        { role: "system", content: "Be terse." },
        { role: "system", content: "Knowledge: ..." },
        { role: "user", content: "hi" },
      ],
    }, "claude-haiku-5-5", 64_000);
    expect(req.system).toBe("Be terse.\n\nKnowledge: ...");
    expect(req.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    for (const k of ["temperature", "top_p", "seed", "presence_penalty"]) expect(req).not.toHaveProperty(k);
    expect(req.cache_control).toEqual({ type: "ephemeral" });
  });

  it("caps max_tokens at the model's limit and defaults it when unset", () => {
    const base: ChatParams = { model: "x", messages: [{ role: "user", content: "hi" }] };
    expect(toAnthropicRequest({ ...base, max_tokens: 200_000 }, "m", 64_000).max_tokens).toBe(64_000);
    expect(toAnthropicRequest({ ...base, max_tokens: 1000 }, "m", 64_000).max_tokens).toBe(1000);
    expect(toAnthropicRequest(base, "m", null).max_tokens).toBe(64_000);
  });

  it("turns images into image blocks and refuses types Claude cannot read", () => {
    const req = toAnthropicRequest({
      model: "x",
      messages: [{ role: "user", content: [
        { type: "text", text: "what is this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "image_url", image_url: { url: "data:image/svg+xml;base64,PHN2Zz4=" } },
      ] }],
    }, "m");
    const content = req.messages[0].content as unknown[];
    expect(content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
    expect(content[2]).toMatchObject({ type: "text", text: expect.stringContaining("image/svg+xml") });
  });

  it("maps tool calls and results, merging consecutive turns of one role", () => {
    const req = toAnthropicRequest({
      model: "x",
      tools: [{ type: "function", function: { name: "lookup", description: "Look up", parameters: { type: "object", properties: { q: { type: "string" } } } } }],
      tool_choice: "required",
      messages: [
        { role: "user", content: "find it" },
        { role: "assistant", content: null, tool_calls: [
          { id: "c1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"a\"}" } },
          { id: "c2", type: "function", function: { name: "lookup", arguments: "not json" } },
        ] },
        { role: "tool", tool_call_id: "c1", content: "A" },
        { role: "tool", tool_call_id: "c2", content: "" },
      ],
    }, "m");
    expect(req.tools).toEqual([{ name: "lookup", description: "Look up", input_schema: { type: "object", properties: { q: { type: "string" } } } }]);
    expect(req.tool_choice).toEqual({ type: "auto" }); // forced tool use is rejected by current models
    expect(req.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "find it" }] },
      { role: "assistant", content: [
        { type: "tool_use", id: "c1", name: "lookup", input: { q: "a" } },
        { type: "tool_use", id: "c2", name: "lookup", input: {} },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "c1", content: "A" },
        { type: "tool_result", tool_use_id: "c2", content: "(no output)" },
      ] },
    ]);
  });

  it("opens with a user turn and asks for JSON when json_object is set", () => {
    const req = toAnthropicRequest({
      model: "x", response_format: { type: "json_object" },
      messages: [{ role: "assistant", content: "Hello!" }, { role: "user", content: "go" }],
    }, "m");
    expect(req.messages[0].role).toBe("user");
    expect(req.system).toMatch(/JSON object/);
  });

  it("asks for server-side fallback only on models that take it", () => {
    const msgs: ChatParams["messages"] = [{ role: "user", content: "hi" }];
    expect(toAnthropicRequest({ model: "x", messages: msgs }, "claude-opus-5-5")).toMatchObject({ fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    expect(toAnthropicRequest({ model: "x", messages: msgs }, "claude-haiku-5-5")).not.toHaveProperty("fallbacks");
  });
});

describe("finishReason and refusalMessage", () => {
  it("maps Claude stop reasons to OpenAI finish reasons", () => {
    expect(finishReason("end_turn")).toBe("stop");
    expect(finishReason("max_tokens")).toBe("length");
    expect(finishReason("tool_use")).toBe("tool_calls");
    expect(finishReason("refusal")).toBe("content_filter");
  });

  it("names the category and points cyber refusals at the verification program", () => {
    const m = refusalMessage({ stop_details: { type: "refusal", category: "cyber", explanation: null } } as never);
    expect(m).toMatch(/safety category: cyber/);
    expect(m).toMatch(/Cyber Verification Program/);
    expect(refusalMessage({ stop_details: null } as never)).toMatch(/^Claude declined this request\./);
  });
});

describe("normaliseAnthropic", () => {
  it("prefixes the id and carries the limits", () => {
    const m = normaliseAnthropic({
      id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-01T00:00:00Z",
      max_input_tokens: 1_000_000, max_tokens: 128_000, lifecycle: "active", capabilities: null,
    } as never);
    expect(m).toMatchObject({ id: "anthropic/claude-opus-5-5", provider: "anthropic", context_length: 1_000_000, max_output_length: 128_000 });
    expect(m.input_modalities).toContain("image");
  });
});

// --- The client, against a fake Messages API stream ------------------------------

const sse = (events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const msgStart = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } };
const text = (index: number, t: string) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index, delta: { type: "text_delta", text: t } },
  { type: "content_block_stop", index },
];
const end = (stop: string, extra: object = {}) => [
  { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null, ...extra }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];

function fakeClient(body: string, status = 200) {
  const seen: { url?: string; body?: Record<string, unknown> } = {};
  const client = new AnthropicChatClient({
    apiKey: () => "sk-ant-test",
    baseUrl: "http://claude.test",
    fetch: (async (url: string, init: RequestInit) => {
      seen.url = String(url);
      seen.body = JSON.parse(String(init.body));
      return new Response(body, { status, headers: { "content-type": status === 200 ? "text/event-stream" : "application/json", "request-id": "req_1" } });
    }) as typeof fetch,
  });
  return { client, seen };
}

async function readAll(res: Response) {
  const raw = await res.text();
  return raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).map((p) => (p === "[DONE]" ? p : JSON.parse(p)));
}

describe("AnthropicChatClient", () => {
  const params: ChatParams = { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }], stream: true };

  it("streams text as OpenAI chunks, then the finish reason, usage and [DONE]", async () => {
    const { client, seen } = fakeClient(sse([msgStart, ...text(0, "Hello"), ...end("end_turn")]));
    const out = await readAll(await client.chatStreamResponse(params));
    expect(seen.url).toContain("/v1/messages");
    expect(seen.body).toMatchObject({ model: "claude-opus-5-5", stream: true, fallbacks: "default" });
    expect(out[0].choices[0].delta).toEqual({ content: "Hello" });
    expect(out[1].choices[0].finish_reason).toBe("stop");
    expect(out[1].usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 5 });
    expect(out[2]).toBe("[DONE]");
  });

  it("sends only the tool calls of the model that finished after a fallback", async () => {
    const { client } = fakeClient(sse([
      msgStart,
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t_old", name: "lookup", input: {} } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t_new", name: "lookup", input: {} } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"q\":\"x\"}" } },
      { type: "content_block_stop", index: 2 },
      ...end("tool_use"),
    ]));
    const out = await readAll(await client.chatStreamResponse(params));
    const calls = out.flatMap((c) => (c === "[DONE]" ? [] : c.choices[0].delta.tool_calls ?? []));
    expect(calls).toEqual([{ index: 0, id: "t_new", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }]);
    expect(out.at(-2).choices[0].finish_reason).toBe("tool_calls");
  });

  it("reports a refusal that stands as an error naming the category", async () => {
    const { client } = fakeClient(sse([msgStart, ...end("refusal", { stop_details: { type: "refusal", category: "cyber", explanation: null } })]));
    await expect(readAll(await client.chatStreamResponse(params))).rejects.toThrow(/safety category: cyber/);
    const once = fakeClient(sse([msgStart, ...end("refusal", { stop_details: { type: "refusal", category: "cyber", explanation: null } })]));
    await expect(once.client.chat({ ...params, stream: false })).rejects.toMatchObject({ status: 422 });
  });

  it("returns a whole completion in OpenAI form", async () => {
    const { client } = fakeClient(sse([msgStart, ...text(0, "Hi "), ...text(1, "there"), ...end("max_tokens")]));
    const c = await client.chat({ ...params, stream: false });
    expect(c.choices[0]).toMatchObject({ finish_reason: "length", message: { role: "assistant", content: "Hi there" } });
  });

  it("turns a rejected key into a 502 that points at the vault, before any stream starts", async () => {
    const { client } = fakeClient(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), 401);
    const err = await client.chatStreamResponse(params).catch((e) => e);
    expect(err).toBeInstanceOf(SCXError);
    expect(err).toMatchObject({ status: 502 });
    expect(err.message).toMatch(/ANTHROPIC_API_KEY/);
  });
});
