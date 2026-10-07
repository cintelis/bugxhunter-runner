import { describe, expect, it } from "vitest";
import { parseSSE, SCXError } from "./scx.js";

const sse = (...chunks: string[]) =>
  new Response(new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(new TextEncoder().encode(c));
      ctrl.close();
    },
  }));

describe("parseSSE", () => {
  it("yields data payloads, including ones split across chunks", async () => {
    const out: string[] = [];
    for await (const d of parseSSE(sse('data: {"a":1}\n\n', 'data: {"b"', ':2}\r\n\n: ping\n', "data: [DONE]\n"))) out.push(d);
    expect(out).toEqual(['{"a":1}', '{"b":2}', "[DONE]"]);
  });

  it("handles a body-less response", async () => {
    const out: string[] = [];
    for await (const d of parseSSE(new Response(null))) out.push(d);
    expect(out).toEqual([]);
  });
});

describe("SCXError", () => {
  it("carries the status and provider type", () => {
    const e = new SCXError(429, "rate limited", "rate_limit");
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(429);
    expect(e.type).toBe("rate_limit");
    expect(e.name).toBe("SCXError");
  });
});
