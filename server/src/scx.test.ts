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

describe("SCXClient timeouts", () => {
  it("reports an upstream that never answers as a 504 with a clear message", async () => {
    const { SCXClient } = await import("./scx.js");
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((_u: unknown, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
    })) as typeof fetch;
    try {
      const c = new SCXClient({ apiKey: () => "k", baseUrl: "https://integrate.api.nvidia.com/v1", timeoutMs: 20 });
      const err = await c.chat({ model: "m", messages: [] }, { timeoutMs: 20 }).catch((e) => e);
      expect(err).toBeInstanceOf(SCXError);
      expect(err.status).toBe(504);
      expect(err.message).toContain("integrate.api.nvidia.com did not start answering within 0s");

      // a whole non-streamed answer gets the long limit unless the caller sets one
      const { NON_STREAM_TIMEOUT_MS } = await import("./scx.js");
      expect(NON_STREAM_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
      const quick = await c.chat({ model: "m", messages: [] }, { timeoutMs: 15 }).catch((e) => e);
      expect(quick.status).toBe(504);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
