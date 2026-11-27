import { describe, it, expect } from "vitest";
import {
  buildChainDemoPrompt, buildChainProposalPrompt, buildReconContinue, driveRecon, RECON_CONTINUE,
  type ReconSessionRunner, type ReconTurnResult,
} from "./recon-driver.js";
import { modelFor, type EnvFidelity, type ReconChain, type ReconFinding } from "./recon.js";

const ENV: EnvFidelity = { kind: "staging", divergences: "seed data" };
const base = { objective: "o", scope: "http://target", env: ENV };
const finding = (over: Partial<ReconFinding> = {}): ReconFinding =>
  ({ title: "t", severity: "medium", repro: "r", verdict: "real", env: "staging", ...over });
const turn = (over: Partial<ReconTurnResult> = {}): ReconTurnResult => ({ tokensUsed: 1, findings: [], madeProgress: true, ...over });

/** A runner that plays `script` in order (each turn built fresh), recording the model and prompt of every turn. */
function scripted(script: (() => ReconTurnResult)[]) {
  const models: string[] = [], prompts: string[] = [];
  let i = 0;
  const runner: ReconSessionRunner = {
    async runTurn({ model, prompt }) {
      models.push(model); prompts.push(prompt);
      if (i >= script.length) throw new Error(`turn ${i + 1} was not scripted`);
      return script[i++]();
    },
  };
  return { runner, models, prompts };
}

/** The main loop's one turn: two findings (F1 low, F2 medium), surface done. */
const twoFindings = () => turn({ done: true, findings: [finding({ title: "User enumeration", severity: "low" }), finding({ title: "IDOR on /runs" })] });
const proposal = (...paths: object[]) => () => turn({ text: "Paths.\n```json\n" + JSON.stringify({ paths }) + "\n```" });
const path = (over: object = {}) => ({ title: "Read any user's runs", goal: "Every user's runs", links: ["F1", "F2"], steps: ["List users", "GET /runs/<id>"], ...over });
const ruling = (over: object = {}) => JSON.stringify({
  kind: "chain", title: "Read any user's runs", verdict: "real", severity: "high", impact: "Every user's runs", links: ["F1", "F2"],
  steps: [{ action: "List users", evidence: "GET /users -> 200" }, { action: "Read a run", evidence: "GET /runs/2 -> 200" }],
  ...over,
});

describe("the chain pass", () => {
  it("proposes on the escalation model, shows each path, and records what the verifier ruled", async () => {
    const seen: number[] = [];
    const { runner, models, prompts } = scripted([
      twoFindings,
      proposal(path()),
      () => turn({ done: true, verifierOutputs: [ruling()] }),
    ]);
    const res = await driveRecon({ ...base, runner, onChainPass: (chains) => seen.push(chains.length) });

    expect(res).toMatchObject({ stopped: "done", chainPass: "ran", rounds: 1, chainRounds: 2, tokens: 3 });
    expect(res.chains).toMatchObject([{ id: "P1", status: "demonstrated", severity: "high", links: ["F1", "F2"], env: "staging" }]);
    expect(models[1]).toBe(modelFor("escalate"));
    expect(prompts[1]).toContain("CHAIN PASS");
    expect(prompts[1]).toContain("F2 [medium] IDOR on /runs");
    expect(prompts[2]).toContain("ATTACK PATH 1 of 1: Read any user's runs");
    expect(prompts[2]).toContain("recon-verify");
    expect(seen).toEqual([0, 1]); // told when the pass starts, and when a path is recorded
  });

  it("does not run with fewer than two findings, when turned off, or after an error", async () => {
    const one = scripted([() => turn({ done: true, findings: [finding()] })]);
    expect(await driveRecon({ ...base, runner: one.runner })).toMatchObject({ chainPass: "few-findings", chainRounds: 0, chains: [] });

    const off = scripted([twoFindings]);
    expect(await driveRecon({ ...base, runner: off.runner, harness: { chainPass: { enabled: false } } })).toMatchObject({ chainPass: "off", chains: [] });

    const broke = scripted([() => turn({ findings: [finding(), finding()] })]); // the second turn throws: not scripted
    expect(await driveRecon({ ...base, runner: broke.runner })).toMatchObject({ stopped: "error", chainPass: "skipped", chains: [] });
    expect(broke.models).toHaveLength(2);
  });

  it("reports no paths when nothing proposed builds on a finding", async () => {
    const { runner, models } = scripted([twoFindings, () => turn({ text: "Nothing combines. {\"paths\": []}" })]);
    expect(await driveRecon({ ...base, runner })).toMatchObject({ chainPass: "no-paths", chainRounds: 1, chains: [] });
    expect(models).toHaveLength(2);
  });

  it("keeps a path the verifier never ruled on as a partial lead that says why", async () => {
    const { runner, prompts } = scripted([
      twoFindings,
      proposal(path({ unproven: 2 }), path({ title: "Second", links: ["F1"] }), path({ title: "Third" })),
      () => turn(), () => turn(), () => turn(),   // path 1: three rounds, no ruling
      () => turn({ stuck: true, madeProgress: false }), // path 2: stuck at once
      () => turn({ done: true }),                 // path 3: says done, but the verifier said nothing
    ]);
    const res = await driveRecon({ ...base, runner });
    expect(res.chainPass).toBe("ran");
    expect(res.chainRounds).toBe(6);
    expect(res.chains.map((c) => [c.id, c.title, c.status, c.blockedWhy, c.severity])).toEqual([
      ["P1", "Read any user's runs", "partial", "not shown within 3 rounds", "medium"], // rated as the worst finding it builds on
      ["P2", "Second", "partial", "the executor could not show it", "low"],
      ["P3", "Third", "partial", "the verifier did not rule on it", "medium"],
    ]);
    expect(res.chains[0].blockedAt).toBe(2);
    expect(res.chains[0].steps).toEqual([{ action: "List users" }, { action: "GET /runs/<id>" }]);
    expect(prompts[3]).toContain("Continue with this attack path only");
  });

  it("gives a path through a High finding the escalation model, and numbers a finding met on the way", async () => {
    const { runner, models } = scripted([
      () => turn({ done: true, findings: [finding({ severity: "high" }), finding()] }),
      proposal(path()),
      () => turn({ done: true, findings: [finding({ title: "New on the way" })], verifierOutputs: [ruling()] }),
    ]);
    const res = await driveRecon({ ...base, runner });
    expect(models[2]).toBe(modelFor("escalate"));
    expect(res.findings.map((f) => f.id)).toEqual(["F1", "F2", "F3"]);
    expect(res.chains[0].status).toBe("demonstrated");
  });

  it("holds tokens back for the pass once there are two findings, and spends no more than the budget", async () => {
    // Budget 100, reserve 15: with two findings the main loop stops once 85 are spent.
    const { runner } = scripted([
      () => turn({ tokensUsed: 50, findings: [finding(), finding()] }),
      () => turn({ tokensUsed: 36 }),                                  // 86 spent: over the main loop's share
      proposal(path(), path({ title: "Second" })),                     // 87
      () => turn({ tokensUsed: 20, verifierOutputs: [ruling()] }),     // 107: the budget is gone
    ]);
    const res = await driveRecon({ ...base, runner, harness: { budgetTokens: 100, maxRounds: 50 } });
    expect(res).toMatchObject({ stopped: "budget", chainPass: "ran", rounds: 2, chainRounds: 2 });
    expect(res.chains.map((c) => [c.status, c.blockedWhy])).toEqual([
      ["demonstrated", undefined],
      ["partial", "not tried: the token budget was spent"],
    ]);
  });

  it("holds nothing back while there are fewer than two findings", async () => {
    const { runner } = scripted([
      () => turn({ tokensUsed: 90, findings: [finding()] }), // 90 of 100: past 85, but no pass is coming
      () => turn({ tokensUsed: 20 }),
    ]);
    expect(await driveRecon({ ...base, runner, harness: { budgetTokens: 100, maxRounds: 50 } }))
      .toMatchObject({ stopped: "budget", rounds: 2, chainPass: "few-findings" });
  });

  it("keeps what it recorded when a turn of the pass fails, and lists the rest as not tried", async () => {
    const { runner } = scripted([
      twoFindings,
      proposal(path(), path({ title: "Second" }), path({ title: "Third" })),
      () => turn({ verifierOutputs: [ruling()] }),
      // the next turn throws: not scripted (a stop by the person arrives the same way)
    ]);
    const res = await driveRecon({ ...base, runner });
    expect(res.chainPass).toBe("error");
    expect(res.stopped).toBe("done"); // how the main loop ended is not rewritten
    expect(res.chains.map((c: ReconChain) => [c.title, c.status, c.blockedWhy])).toEqual([
      ["Read any user's runs", "demonstrated", undefined],
      ["Second", "partial", "not tried: the run stopped"],
      ["Third", "partial", "not tried: the run stopped"],
    ]);
  });

  it("stays within the caps on paths and rounds", async () => {
    const many = Array.from({ length: 6 }, (_, n) => path({ title: `P${n}` }));
    const { runner, models } = scripted([
      twoFindings, proposal(...many),
      () => turn(), () => turn(),   // path 1: two rounds
      () => turn(), () => turn(),   // path 2: two rounds
    ]);
    const res = await driveRecon({ ...base, runner, harness: { chainPass: { maxCandidates: 2, maxRoundsPerChain: 2 } } });
    expect(res.chains).toHaveLength(2);
    expect(res.chainRounds).toBe(5);
    expect(models).toHaveLength(6);
  });
});

describe("following a finding up in the main loop", () => {
  it("asks for the next hypothesis until something is verified, then for what the findings unlock", async () => {
    const { runner, prompts } = scripted([
      () => turn(),
      () => turn({ findings: [finding({ title: "Debug token in /status", severity: "low" })] }),
      () => turn({ done: true }),
    ]);
    await driveRecon({ ...base, runner });
    expect(prompts[1]).toBe(RECON_CONTINUE);
    expect(prompts[2]).toMatch(/^Continue:/);
    for (const s of ["F1 [low] Debug token in /status", "has not been used yet", "ATTACK PATH", "pauses for human approval", "next untested hypothesis within scope", "RECON-STATUS"]) expect(prompts[2]).toContain(s);
    expect(prompts[2]).not.toContain("already recorded");
  });

  it("records a path the verifier rules on mid-loop, and neither round asks for it again", async () => {
    const seen: string[][] = [], phases: number[] = [];
    const { runner, prompts } = scripted([
      () => ({ ...twoFindings(), done: false }),                      // the loop goes on
      () => turn({ verifierOutputs: [ruling()] }),                    // followed F1 and F2 up
      () => turn({ done: true }),
      () => turn({ text: '{"paths": []}' }),                          // the chain pass's proposal turn
    ]);
    const res = await driveRecon({ ...base, runner, onChains: (c) => seen.push(c.map((x) => x.id ?? "")), onChainPass: (c) => phases.push(c.length) });

    expect(res).toMatchObject({ stopped: "done", rounds: 3, chainRounds: 1, chainPass: "no-paths" });
    expect(res.chains).toMatchObject([{ id: "P1", status: "demonstrated", severity: "high", links: ["F1", "F2"] }]);
    expect(seen).toEqual([["P1"]]);
    expect(phases).toEqual([1]); // the pass starts with the path already there
    expect(prompts[2]).toContain("Attack paths already recorded (do not repeat them):\nP1 [demonstrated] Read any user's runs (F1, F2)");
    expect(prompts[3]).toContain("CHAIN PASS");
    expect(prompts[3]).toContain("Do not propose them again");
    expect(prompts[3]).toContain("P1 [demonstrated] Read any user's runs (F1, F2)");
  });

  it("gives the round after a demonstrated High path the escalation model", async () => {
    const { runner, models } = scripted([
      () => ({ ...twoFindings(), done: false }),
      () => turn({ verifierOutputs: [ruling()] }),
      () => turn({ done: true }),
      () => turn({ text: '{"paths": []}' }),
    ]);
    await driveRecon({ ...base, runner });
    expect(models[1]).not.toBe(modelFor("escalate")); // Low and Medium findings do not escalate
    expect(models[2]).toBe(modelFor("escalate"));
  });

  it("lists only the newest findings when there are many", () => {
    const many = Array.from({ length: 40 }, (_, n) => finding({ id: `F${n + 1}`, title: `T${n + 1}` }));
    const p = buildReconContinue(many);
    expect(p).not.toContain("F10 [medium] T10");
    expect(p).toContain("F11 [medium] T11");
    expect(p).toContain("F40 [medium] T40");
  });
});

describe("chain pass prompts", () => {
  const findings = [finding({ id: "F1", title: "User enumeration", severity: "low" }), finding({ id: "F2", title: "Debug token", verdict: "config-dependent" })];

  it("lists the findings by id and asks for the json block", () => {
    const p = buildChainProposalPrompt(findings, 3);
    for (const s of ["Do not run any tool", "F1 [low] User enumeration", "F2 [medium, config-dependent] Debug token", "up to 3 attack paths", '{"paths"']) expect(p).toContain(s);
  });

  it("names the path, the findings it builds on, the unproven step, and the approval rule", () => {
    const p = buildChainDemoPrompt({ title: "Takeover", goal: "An admin session", links: ["F2"], steps: ["Mint a token", "Use it on /admin"], unproven: 2 }, 2, 3, findings);
    for (const s of ["ATTACK PATH 2 of 3: Takeover", "Goal: An admin session", "F2 [medium, config-dependent]", "1. Mint a token", "Step 2 is the one that has not been shown", "pauses for human approval", "RECON-STATUS: done"]) expect(p).toContain(s);
    expect(p).not.toContain("F1 [low]"); // only the findings this path builds on
  });
});
