import { afterEach, describe, expect, it, vi } from "vitest";
import { runChat } from "./api";

const sse = (...lines: string[]) =>
  new Response(new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(new TextEncoder().encode(l));
      c.close();
    },
  }), { status: 200 });

function run(response: Response) {
  vi.stubGlobal("fetch", vi.fn(async () => response));
  const out: { text: string; done?: string | null; error: string } = { text: "", error: "" };
  return runChat({ model: "m", messages: [] }, {
    onDelta: (t) => { out.text += t; },
    onDone: (f) => { out.done = f; },
    onError: (m) => { out.error = m; },
  }).then(() => out);
}

afterEach(() => vi.unstubAllGlobals());

describe("runChat stream endings", () => {
  const delta = (c: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;

  it("finishes normally on [DONE]", async () => {
    const out = await run(sse(delta("hi"), `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`, "data: [DONE]\n\n"));
    expect(out).toMatchObject({ text: "hi", done: "stop", error: "" });
  });

  it("reports a stream that closes mid-answer instead of finishing quietly", async () => {
    const out = await run(sse(delta("partial")));
    expect(out.done).toBeUndefined();
    expect(out.error).toMatch(/connection closed before the model finished/);
    expect(out.text).toBe("partial");
  });

  it("accepts a finish reason without [DONE] as a normal end", async () => {
    const out = await run(sse(delta("ok"), `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`));
    expect(out).toMatchObject({ done: "length", error: "" });
  });
});
