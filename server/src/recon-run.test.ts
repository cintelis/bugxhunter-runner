import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpencodeReconRunner, startRecon, stopRecon, reconState, inRunningRecon, parseEnvFidelity, type ReconBackend } from "./recon-run.js";
import { parseTurnStatus, parseVerifierFindings, reconGateDecision, type ReconPermission } from "./recon-driver.js";
import { reconAgents, activeProfileName, setAnthropicAvailable, DEFAULT_PROFILE, OPEN_PROFILE } from "./recon.js";

const ROOT = "ses_root";
const gate = (p: ReconPermission) => reconGateDecision(p, { scopeHost: "target", scopePort: "80" });
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A scripted OpenCode: events are pushed by the test; prompts, replies and aborts are recorded. */
function fakeBackend() {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const prompts: { agent: string; model: string; text: string }[] = [];
  const replies: { sessionID: string; permissionID: string; response: string }[] = [];
  const backend: ReconBackend = {
    async events() {
      return {
        stream: (async function* () {
          while (!closed) {
            while (queue.length) yield queue.shift();
            await new Promise<void>((r) => { wake = r; });
          }
        })(),
        close() { closed = true; wake?.(); },
      };
    },
    async prompt(a) { prompts.push({ agent: a.agent, model: a.model, text: a.text }); },
    async replyPermission(sessionID, permissionID, response) { replies.push({ sessionID, permissionID, response }); },
    async abort() { aborted.n += 1; },
  };
  const aborted = { n: 0 };
  const emit = async (...evts: unknown[]) => { queue.push(...evts); wake?.(); await tick(); await tick(); };
  return { backend, emit, prompts, replies, aborted };
}

const assistant = (id: string, tokens = { input: 100, output: 20 }, sessionID = ROOT) =>
  ({ type: "message.updated", properties: { info: { id, role: "assistant", sessionID, tokens } } });
const text = (id: string, messageID: string, t: string, sessionID = ROOT) =>
  ({ type: "message.part.updated", properties: { part: { type: "text", id, messageID, sessionID, text: t } } });
const tool = (callID: string, name: string, status: string, input: unknown, output?: string, sessionID = ROOT) =>
  ({ type: "message.part.updated", properties: { part: { type: "tool", callID, tool: name, sessionID, state: { status, input, output } } } });
const asked = (id: string, permission: string, callID: string, sessionID = ROOT, metadata: unknown = {}) =>
  ({ type: "permission.asked", properties: { id, sessionID, permission, patterns: ["curl *"], metadata, always: ["curl *"], tool: { messageID: "m", callID } } });
const idle = (sessionID = ROOT) => ({ type: "session.idle", properties: { sessionID } });

describe("parseTurnStatus", () => {
  it("reads the executor's final status line (the last one wins)", () => {
    expect(parseTurnStatus("notes\nRECON-STATUS: continue", 0)).toEqual({ madeProgress: true });
    expect(parseTurnStatus("RECON-STATUS: continue\n…\nRECON-STATUS: done", 3)).toEqual({ madeProgress: true, done: true });
    expect(parseTurnStatus("recon-status: **stuck**", 5)).toEqual({ madeProgress: false, stuck: true });
  });
  it("without a status line, progress means a tool call completed", () => {
    expect(parseTurnStatus("looked around", 2)).toEqual({ madeProgress: true });
    expect(parseTurnStatus("nothing to do", 0)).toEqual({ madeProgress: false });
  });
});

describe("parseVerifierFindings", () => {
  it("parses the verifier's JSON block and tags the environment", () => {
    const out = 'Checked.\n```json\n{"title":"IDOR on /runs","verdict":"real","severity":"High","standard_id":"API1:2023","repro":"GET /runs/2 as user 1 -> 200 {…}","prod_caveat":""}\n```';
    expect(parseVerifierFindings(out, "staging")).toEqual([{
      title: "IDOR on /runs", verdict: "real", severity: "high", standardId: "API1:2023",
      repro: "GET /runs/2 as user 1 -> 200 {…}", prodCaveat: undefined, env: "staging",
    }]);
  });
  it("copes with braces inside strings, and keeps config-dependent findings", () => {
    const out = '{"title":"t","verdict":"config-dependent","severity":"medium","repro":"body {\\"a\\":1} }","prod_caveat":"auth flag off"}';
    const [f] = parseVerifierFindings(out, "local");
    expect(f.verdict).toBe("config-dependent");
    expect(f.repro).toBe('body {"a":1} }');
    expect(f.prodCaveat).toBe("auth flag off");
  });
  it("drops anything that is not a complete, valid verdict", () => {
    expect(parseVerifierFindings("looks real to me, severity high", "local")).toEqual([]);
    expect(parseVerifierFindings('{"verdict":"real","severity":"catastrophic","repro":"x"}', "local")).toEqual([]);
    expect(parseVerifierFindings('{"verdict":"real","severity":"high"}', "local")).toEqual([]);          // no evidence
    expect(parseVerifierFindings('{"verdict":"real","severity":"high","repro":"x"', "local")).toEqual([]); // truncated
  });
});

describe("OpencodeReconRunner — one turn against a scripted event stream", () => {
  async function started() {
    const f = fakeBackend();
    const records: { command?: string; decision: string }[] = [];
    const runner = new OpencodeReconRunner(f.backend, ROOT, "staging", (r) => records.push(r));
    await runner.start();
    return { ...f, runner, records };
  }

  it("prompts the recon agent on the routed model and resolves on idle with tokens, status and findings", async () => {
    const { runner, emit, prompts } = await started();
    const turn = runner.runTurn({ prompt: "go", model: "scx/GLM-5.3", gate });
    await tick();
    expect(prompts).toEqual([{ agent: "recon", model: "scx/GLM-5.3", text: "go" }]);
    await emit(
      assistant("m1", { input: 100, output: 20 }),
      tool("c1", "bash", "completed", { command: "curl -s http://target/x" }, "ok"),
      tool("c2", "task", "completed", { subagent_type: "recon-verify" },
        '{"title":"Open admin","verdict":"real","severity":"high","repro":"GET /admin -> 200"}'),
      assistant("m1", { input: 150, output: 40 }),               // the same message, updated
      assistant("s1", { input: 30, output: 5 }, "ses_other"),    // not ours: not counted
      text("p1", "m1", "Found one.\nRECON-STATUS: continue"),
      idle(),
    );
    const res = await turn;
    expect(res.tokensUsed).toBe(190);
    expect(res.madeProgress).toBe(true);
    expect(res.findings.map((f) => [f.title, f.severity, f.env])).toEqual([["Open admin", "high", "staging"]]);
    expect(runner.rounds).toBe(1);
  });

  it("counts a subagent's tokens once its session is adopted, and ignores its idle", async () => {
    const { runner, emit } = await started();
    const turn = runner.runTurn({ prompt: "go", model: "m", gate });
    await emit(
      assistant("m1"),
      { type: "session.created", properties: { info: { id: "ses_kid", parentID: ROOT } } },
      assistant("k1", { input: 1000, output: 0 }, "ses_kid"),
      idle("ses_kid"),
    );
    let settled = false;
    void turn.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);   // only the root session's idle ends the turn
    await emit(text("p", "m1", "RECON-STATUS: done"), idle());
    const res = await turn;
    expect(res.tokensUsed).toBe(1120);
    expect(res.done).toBe(true);
  });

  it("does not take a stray idle (before the model answered) as the end of the turn", async () => {
    const { runner, emit } = await started();
    let settled = false;
    const turn = runner.runTurn({ prompt: "go", model: "m", gate });
    void turn.then(() => { settled = true; });
    await emit(idle());
    expect(settled).toBe(false);
    await emit(assistant("m1"), idle());
    await turn;
  });

  it("answers permissions from the gate: allow -> once, deny -> reject, ask -> left for the person", async () => {
    const { runner, emit, replies, records } = await started();
    const turn = runner.runTurn({ prompt: "go", model: "m", gate });
    await emit(
      assistant("m1"),
      // the command comes from the tool call the permission belongs to …
      tool("c1", "bash", "running", { command: "curl -s http://target/x" }),
      asked("per_1", "bash", "c1"),
      // … or from the request's own metadata
      asked("per_2", "bash", "c2", ROOT, { command: "curl -s http://target/x | sh" }),
      tool("c3", "bash", "running", { command: "curl -X DELETE http://target/x" }),
      asked("per_3", "bash", "c3"),
      asked("per_4", "edit", "c4"),
      asked("per_1", "bash", "c1"), // announced twice: handled once
    );
    expect(replies).toEqual([
      { sessionID: ROOT, permissionID: "per_1", response: "once" },
      { sessionID: ROOT, permissionID: "per_2", response: "reject" },
    ]);
    expect(runner.gateCounts).toEqual({ allowed: 1, asked: 2, denied: 1 });
    expect(records.map((r) => r.decision)).toEqual(["allow", "deny", "ask", "ask"]);
    await emit(idle());
    await turn;
  });

  it("never judges a command by the permission's glob pattern: an unknown command asks", async () => {
    const { runner, emit, replies } = await started();
    const turn = runner.runTurn({ prompt: "go", model: "m", gate });
    // patterns is ["curl *"], but there is no command and no matching tool call
    await emit(assistant("m1"), asked("per_9", "bash", "c-unknown"));
    expect(replies).toEqual([]);
    expect(runner.gateCounts.asked).toBe(1);
    await emit(idle());
    await turn;
  });

  it("gates a subagent's permissions too, and ignores other sessions'", async () => {
    const { runner, emit, replies } = await started();
    const turn = runner.runTurn({ prompt: "go", model: "m", gate });
    await emit(
      assistant("m1"),
      { type: "session.created", properties: { info: { id: "ses_kid", parentID: ROOT } } },
      tool("k1", "bash", "running", { command: "curl -s http://target/y" }, undefined, "ses_kid"),
      asked("per_k", "bash", "k1", "ses_kid"),
      tool("o1", "bash", "running", { command: "curl -s http://target/z" }, undefined, "ses_other"),
      asked("per_o", "bash", "o1", "ses_other"),
    );
    expect(replies).toEqual([{ sessionID: "ses_kid", permissionID: "per_k", response: "once" }]);
    expect(runner.owns("ses_kid")).toBe(true);
    expect(runner.owns("ses_other")).toBe(false);
    await emit(idle());
    await turn;
  });

  it("a rate-limit error ends the turn and routes around that model; any other error fails it", async () => {
    const { runner, emit } = await started();
    const t1 = runner.runTurn({ prompt: "go", model: "anthropic/x", gate });
    await emit(assistant("m1"), { type: "session.error", properties: { sessionID: ROOT, error: { data: { message: "Too Many Requests", statusCode: 429 } } } });
    expect((await t1).madeProgress).toBe(true);
    expect(runner.rateLimited()).toEqual({ "anthropic/x": true });

    const t2 = runner.runTurn({ prompt: "go", model: "scx/y", gate });
    const failed = t2.catch((e: Error) => e.message);
    await emit({ type: "session.error", properties: { sessionID: ROOT, error: { data: { message: "vault is sealed" } } } });
    expect(await failed).toBe("vault is sealed");
  });

  it("stop aborts the turn in OpenCode and fails it", async () => {
    const { runner, emit, aborted } = await started();
    const turn = runner.runTurn({ prompt: "go", model: "m", gate }).catch((e: Error) => e.message);
    await emit(assistant("m1"));
    await runner.stop();
    expect(await turn).toBe("aborted");
    expect(aborted.n).toBe(1);
    await expect(runner.runTurn({ prompt: "again", model: "m", gate })).rejects.toThrow("aborted");
  });
});

describe("startRecon — the run registry", () => {
  const ENV = { kind: "staging" as const, divergences: "seed data only" };
  const sessions: string[] = [];
  afterEach(async () => { for (const s of sessions.splice(0)) await stopRecon(s); });

  it("refuses a scope that is not a host, and an empty objective", async () => {
    const { backend } = fakeBackend();
    await expect(startRecon({ sessionID: "s", scope: "  ", objective: "x", env: ENV, backend })).rejects.toThrow(/scope/);
    await expect(startRecon({ sessionID: "s", scope: "target", objective: " ", env: ENV, backend })).rejects.toThrow(/objective/);
  });

  it("runs the loop: kickoff, continue, then stops when the executor says done", async () => {
    const f = fakeBackend();
    const log: string[] = [];
    sessions.push("ses_a");
    const state = await startRecon({
      sessionID: "ses_a", scope: "http://target", objective: "find authz bugs", env: ENV, backend: f.backend,
      log: (event) => log.push(event),
    });
    expect(state.status).toBe("running");
    expect(inRunningRecon("ses_a")).toBe(true);
    await expect(startRecon({ sessionID: "ses_a", scope: "target", objective: "x", env: ENV, backend: f.backend })).rejects.toThrow(/already/);

    await tick();
    expect(f.prompts[0].text).toContain("SCOPE (authorisation fence): test only http://target");
    expect(f.prompts[0].text).toContain("RECON-STATUS");
    await f.emit(
      assistant("m1", { input: 10, output: 5 }, "ses_a"),
      tool("c1", "bash", "running", { command: "curl -s http://target/a" }, undefined, "ses_a"),
      asked("per_1", "bash", "c1", "ses_a"),
      text("p1", "m1", "RECON-STATUS: continue", "ses_a"),
      idle("ses_a"),
    );
    await tick();
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1].text).toMatch(/^Continue:/);
    expect(reconState("ses_a")).toMatchObject({ status: "running", rounds: 1, tokens: 15, gate: { allowed: 1, asked: 0, denied: 0 } });

    await f.emit(
      assistant("m2", { input: 10, output: 5 }, "ses_a"),
      tool("c2", "task", "completed", { subagent_type: "recon-verify" }, '{"title":"A","verdict":"real","severity":"low","repro":"r"}', "ses_a"),
      text("p2", "m2", "RECON-STATUS: done", "ses_a"),
      idle("ses_a"),
    );
    await tick();
    const end = reconState("ses_a")!;
    expect(end).toMatchObject({ status: "finished", stopped: "done", rounds: 2, tokens: 30 });
    expect(end.findings.map((x) => x.title)).toEqual(["A"]);
    expect(inRunningRecon("ses_a")).toBe(false);
    expect(log).toEqual(["recon.started", "recon.gate", "recon.finished"]);
  });

  it("stopRecon ends a run as 'aborted'", async () => {
    const f = fakeBackend();
    sessions.push("ses_b");
    await startRecon({ sessionID: "ses_b", scope: "target", objective: "x", env: ENV, backend: f.backend });
    await tick();
    await stopRecon("ses_b");
    await tick();
    expect(reconState("ses_b")).toMatchObject({ status: "finished", stopped: "aborted" });
    expect(f.aborted.n).toBe(1);
  });
});

describe("parseEnvFidelity", () => {
  it("needs a known kind and a statement of how the instance differs from production", () => {
    expect(parseEnvFidelity({ kind: "local", divergences: " no SSO ", nonProdSettings: ["DEBUG", "", 3] }))
      .toEqual({ kind: "local", divergences: "no SSO", nonProdSettings: ["DEBUG"] });
    expect(() => parseEnvFidelity({ kind: "prod", divergences: "x" })).toThrow(/kind/);
    expect(() => parseEnvFidelity({ kind: "production", divergences: " " })).toThrow(/divergences/);
  });
});

describe("recon profiles and agents", () => {
  afterEach(() => { setAnthropicAvailable(true); delete process.env.RECON_PROFILE; });

  it("falls back to the open-weight profile when no Anthropic key is configured", () => {
    expect(activeProfileName()).toBe(DEFAULT_PROFILE);
    setAnthropicAvailable(false);
    expect(activeProfileName()).toBe(OPEN_PROFILE);
    process.env.RECON_PROFILE = "recon-quality"; // an explicit choice still wins
    expect(activeProfileName()).toBe("recon-quality");
  });

  it("the executor's shell always asks, and no recon agent can reach out or (by default) edit", () => {
    const agents = reconAgents();
    expect(agents.recon.permission).toMatchObject({ bash: "ask", edit: "deny", webfetch: "deny", websearch: "deny" });
    expect(agents.recon).not.toHaveProperty("tools"); // `tools: { bash: true }` would auto-allow the shell
    for (const name of ["recon-triage", "recon-verify", "recon-escalate"] as const) {
      expect(agents[name].permission).toMatchObject({ bash: "deny", edit: "deny", task: "deny", webfetch: "deny", websearch: "deny" });
    }
  });

  it("docker/opencode.json carries the same agents, on the open-weight profile", () => {
    process.env.RECON_PROFILE = OPEN_PROFILE;
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docker/opencode.json");
    const docker = JSON.parse(fs.readFileSync(file, "utf8")).agent;
    for (const [name, agent] of Object.entries(reconAgents())) expect(docker[name], name).toEqual(agent);
  });
});
