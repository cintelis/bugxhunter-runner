import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ToolOutcome } from "@sigilant/sdk";

import { discoverPrompt, parsePr, reviewPrompt, startRun, usageReporter } from "./run.ts";

test("a run is a session in the folder, then the prompt to it", async () => {
  const posted: { path: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    posted.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify(path.endsWith("/session") ? { id: "ses_1", directory: "/workspace/engagement" } : { ok: true }), { status: 200 });
  };
  const id = await startRun("http://bxh-runner:8790", { directory: "/workspace/engagement", text: "Review it.", model: "scx/GLM-5.3" }, fetchImpl);
  assert.equal(id, "ses_1");
  assert.deepEqual(posted, [
    { path: "/api/agent/session", body: { directory: "/workspace/engagement" } },
    { path: "/api/agent/prompt", body: { sessionID: "ses_1", directory: "/workspace/engagement", text: "Review it.", agent: "build", model: "scx/GLM-5.3" } },
  ]);
});

test("a runner that refuses is reported with what it said", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ error: { message: "Host is not allowed" } }), { status: 403 });
  await assert.rejects(startRun("http://x", { directory: "/w", text: "t" }, fetchImpl), /\/api\/agent\/session: HTTP 403: .*Host is not allowed/);
});

test("a step's usage is reported as run.usage, and a gateway that will not take it is said, not thrown", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const outcomes: ToolOutcome[] = [
    { status: "done", isError: false, content: [], text: "" },
    { status: "denied", reason: "policy", message: "no", detail: "" } as ToolOutcome,
  ];
  const client = {
    async callUntilDecided(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return outcomes.shift()!;
    },
  };
  const lines: string[] = [];
  const report = usageReporter(client, (l) => lines.push(l));
  const step = { run: "ses_1", step: "m1", model: "scx/x", input: 1, output: 2, reasoning: 0, cache_read: 0, cache_write: 0, cost_micros: 3, started_ms: 1, completed_ms: 2, tool_calls: 0 };
  await report(step);
  await report({ ...step, step: "m2" });
  assert.deepEqual(calls.map((c) => c.name), ["run.usage", "run.usage"]);
  assert.deepEqual(calls[0]!.args, step);
  assert.match(lines[0]!, /^reported m1: scx\/x, 1 in, 2 out/);
  assert.match(lines[1]!, /did not take m2's usage: denied \(policy\)/);
});

test("a discovery run is told the scope as given, and that nothing outside it counts", () => {
  const prompt = discoverPrompt(["cintelis/sigilant"], ["erp:9443", "fleet-tools:9443"]);
  assert.match(prompt, /repo\.scan: cintelis\/sigilant\./);
  assert.match(prompt, /net\.discover: erp:9443, fleet-tools:9443\./);
  assert.match(prompt, /nothing outside the scope/);
  assert.match(discoverPrompt([], ["erp:9443"]), /no repositories in scope/);
});

test("a pull request is named owner/name#number, and the prompt names it back", () => {
  assert.deepEqual(parsePr("cintelis/sigilant#42"), { repo: "cintelis/sigilant", pr: 42 });
  assert.equal(parsePr("cintelis/sigilant"), undefined);
  assert.equal(parsePr("../x#1"), undefined);
  const prompt = reviewPrompt("cintelis/sigilant", 42);
  assert.match(prompt, /pull request #42 of cintelis\/sigilant/);
  assert.match(prompt, /repo\.read \(repo "cintelis\/sigilant", pr 42\)/);
  assert.match(prompt, /Do nothing outside this pull request\./);
});
