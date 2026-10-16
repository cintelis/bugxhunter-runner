import { strict as assert } from "node:assert";
import { test } from "node:test";

import { GatewayRefused, type ToolOutcome } from "@sigilant/sdk";

import { type Caller, bridge } from "./bridge.ts";

/** A gateway that answers each call as told. */
function caller(answers: Record<string, ToolOutcome | Error>): Caller & { calls: { name: string; args: Record<string, unknown> }[] } {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    listTools: async () => [{ name: "repo.read", description: "reads", inputSchema: { type: "object" } }, { name: "finding.record" }],
    callUntilDecided: async (name, args) => {
      calls.push({ name, args });
      const a = answers[name];
      if (a instanceof Error) throw a;
      if (!a) throw new Error(`no answer for ${name}`);
      return a;
    },
  };
}

const lines: string[] = [];
const server = (answers: Record<string, ToolOutcome | Error>) => bridge(caller(answers), { waitSecs: 1, log: (l) => lines.push(l) });

test("the tools are the gateway's, with a schema where it gave none", async () => {
  const tools = await server({}).tools();
  assert.deepEqual(tools, [
    { name: "repo.read", description: "reads", inputSchema: { type: "object" } },
    { name: "finding.record", description: "", inputSchema: { type: "object" } },
  ]);
});

test("listing the tools is tried again while the gateway is not ready, and given up on in the end", async () => {
  let asked = 0;
  const flaky: Caller = {
    listTools: async () => {
      asked++;
      if (asked < 3) throw new GatewayRefused(503, "not signing yet");
      return [{ name: "repo.read" }];
    },
    callUntilDecided: async () => {
      throw new Error("not called");
    },
  };
  const tools = await bridge(flaky, { waitSecs: 1, listForSecs: 1, listEverySecs: 0.01, log: (l) => lines.push(l) }).tools();
  assert.deepEqual(tools.map((t) => t.name), ["repo.read"]);
  assert.equal(asked, 3);
  const never: Caller = { ...flaky, listTools: async () => { throw new GatewayRefused(503, "still not"); } };
  await assert.rejects(bridge(never, { waitSecs: 1, listForSecs: 0.05, listEverySecs: 0.01 }).tools(), /still not/);
});

test("an allowed call is the tool's answer, error or not", async () => {
  const done: ToolOutcome = { status: "done", isError: false, content: [{ type: "text", text: "{\"ok\":1}" }], structuredContent: { ok: 1 }, text: "{\"ok\":1}" };
  const r = await server({ "repo.read": done }).call("repo.read", { repo: "a/b", path: "x" });
  assert.deepEqual(r, { isError: false, content: [{ type: "text", text: "{\"ok\":1}" }], structuredContent: { ok: 1 } });
  const failedTool: ToolOutcome = { ...done, isError: true, content: [{ type: "image", data: "…" }] };
  const e = await server({ "repo.read": failedTool }).call("repo.read", {});
  assert.equal(e.isError, true);
  assert.equal(e.content[0]!.text, JSON.stringify({ type: "image", data: "…" }), "what is not text is said as JSON");
});

test("a call still held after the wait says so, and what to do", async () => {
  const pending: ToolOutcome = { status: "pending", approvalId: "req-1", approvers: ["group:bxh-testers"], expiresAt: 1_800_000_000, message: "Held for a person." };
  const r = await server({ "finding.record": pending }).call("finding.record", { severity: "critical", title: "x" });
  assert.equal(r.isError, false);
  assert.match(r.content[0]!.text, /^Held for a person\. Still waiting after 1 seconds/);
  assert.match(r.content[0]!.text, /do not look for another way/);
  assert.deepEqual(r.structuredContent, { sigilant: { decision: "step_up", approval_id: "req-1", approvers: ["group:bxh-testers"], expires_at: 1_800_000_000 } });
});

test("a denial and a failure are errors that say what to do, in the gateway's words where it gave them", async () => {
  const denied: ToolOutcome = { status: "denied", reason: "policy", detail: "outside the scope", message: "Denied: outside the engagement's scope. Re-plan." };
  const d = await server({ "repo.read": denied }).call("repo.read", { repo: "x/y", path: "z" });
  assert.equal(d.isError, true);
  assert.equal(d.content[0]!.text, "Denied: outside the engagement's scope. Re-plan.");
  assert.deepEqual(d.structuredContent, { sigilant: { decision: "deny", reason: "policy", detail: "outside the scope" } });
  const failed: ToolOutcome = { status: "failed", reason: "upstream_unreachable", message: "" };
  const f = await server({ "repo.read": failed }).call("repo.read", {});
  assert.equal(f.isError, true);
  assert.match(f.content[0]!.text, /could not carry out repo\.read: upstream_unreachable/);
});

test("a refusal of the token itself tells the agent to stop", async () => {
  const revoked = await server({ "repo.read": new GatewayRefused(403, "revoked") }).call("repo.read", {});
  assert.equal(revoked.isError, true);
  assert.match(revoked.content[0]!.text, /has revoked this agent.*Stop/);
  const expired = await server({ "repo.read": new GatewayRefused(401, "expired") }).call("repo.read", {});
  assert.match(expired.content[0]!.text, /would not identify this agent.*Stop and report/);
  await assert.rejects(server({ "repo.read": new Error("network") }).call("repo.read", {}), /network/, "anything else is the caller's to see");
});
