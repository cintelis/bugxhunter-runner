import { strict as assert } from "node:assert";
import { test } from "node:test";

import { discoverPrompt, parsePr, reviewPrompt, startRun } from "./run.ts";

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
