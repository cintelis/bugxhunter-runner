import { strict as assert } from "node:assert";
import { test } from "node:test";

import { type Message, type StepUsage, describeStep, followRun, stepsOf } from "./usage.ts";

const assistant = (id: string, created: number, completed: number | undefined, extra: Partial<Message> = {}): Message => ({
  id,
  role: "assistant",
  parts: [{ type: "text" }, { type: "tool", status: "completed" }],
  tokens: { input: 1200, output: 300, reasoning: 50, cache: { read: 1000, write: 0 } },
  cost: 0.0042,
  model: "scx/GLM-5.3",
  time: { created, completed },
  ...extra,
});

test("the steps of a run are its finished assistant messages, with what OpenCode counted", () => {
  const steps = stepsOf("ses_1", [
    { id: "u1", role: "user", time: { created: 1_000 } },
    assistant("m2", 5_000, 9_000),
    assistant("m1", 1_000, 4_000, { parts: [{ type: "text" }] }),
    assistant("m3", 10_000, undefined),
  ]);
  assert.deepEqual(steps.map((s) => s.step), ["m1", "m2"], "in the order they began; one still going is not a step yet");
  assert.deepEqual(steps[1], {
    run: "ses_1", step: "m2", model: "scx/GLM-5.3",
    input: 1200, output: 300, reasoning: 50, cache_read: 1000, cache_write: 0,
    cost_micros: 4200, started_ms: 5_000, completed_ms: 9_000, tool_calls: 1,
  });
  assert.equal(steps[0]!.tool_calls, 0);
  const bare = stepsOf("ses_1", [{ id: "m9", role: "assistant", time: { completed: 7_000 } }])[0]!;
  assert.deepEqual([bare.input, bare.cost_micros, bare.started_ms, bare.model], [0, 0, 7_000, undefined], "counts left out are nought");
  assert.match(describeStep(steps[1]!), /^m2: scx\/GLM-5\.3, 1200 in, 300 out, \$0\.0042, 4\.0 s, 1 tool call$/);
});

/** A runner whose event stream says what `frames` say, and whose messages are `messages` when read. */
function runner(frames: string[], messages: () => Message[]) {
  const asked: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    asked.push(url.pathname);
    if (url.pathname === "/api/agent/events") {
      assert.equal(url.searchParams.get("sessionID"), "ses_1");
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const frame of frames) {
            controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
            await new Promise((r) => setTimeout(r, 5));
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname.endsWith("/messages")) return new Response(JSON.stringify({ messages: messages() }), { status: 200 });
    return new Response("no", { status: 404 });
  };
  return { asked, fetchImpl };
}

test("a run is followed until it is idle, and each step is reported once", async () => {
  let done = false;
  const r = runner(
    [JSON.stringify({ kind: "open" }), JSON.stringify({ kind: "message", role: "assistant" }), JSON.stringify({ kind: "idle", sessionID: "other" }), JSON.stringify({ kind: "idle", sessionID: "ses_1", subagent: "helper" }), JSON.stringify({ kind: "idle", sessionID: "ses_1" })],
    () => [assistant("m1", 1_000, 4_000), ...(done ? [assistant("m2", 5_000, 9_000)] : [assistant("m2", 5_000, undefined)])],
  );
  const reported: StepUsage[] = [];
  const lines: string[] = [];
  // Read early, while m2 is still going; then, idle, read again: m2 is reported then, m1 not twice.
  const steps = await followRun(
    "http://bxh-runner:8790",
    "ses_1",
    "/workspace/engagement",
    async (step) => {
      reported.push(step);
      done = true;
    },
    { fetchImpl: r.fetchImpl, everyMs: 0, log: (l) => lines.push(l) },
  );
  assert.deepEqual(reported.map((s) => s.step), ["m1", "m2"]);
  assert.deepEqual(steps, reported);
  assert.ok(r.asked.filter((p) => p.endsWith("/messages")).length >= 2);
  assert.deepEqual(lines, []);
});

test("a stream that ends early is opened again, and a run never idle is reported when time is up", async () => {
  let opened = 0;
  const r = runner([JSON.stringify({ kind: "open" })], () => [assistant("m1", 1_000, 4_000)]);
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).includes("/events")) opened++;
    return r.fetchImpl(input, init);
  };
  const lines: string[] = [];
  const steps = await followRun("http://x", "ses_1", "/w", async () => {}, { fetchImpl, everyMs: 1_000_000, forMs: 400, log: (l) => lines.push(l) });
  assert.ok(opened >= 2, `opened ${opened} times`);
  assert.deepEqual(steps.map((s) => s.step), ["m1"]);
  assert.ok(lines.some((l) => /ended before the run was idle/.test(l)));
  assert.ok(lines.some((l) => /gave up following ses_1/.test(l)));
});
