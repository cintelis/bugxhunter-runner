import { describe, it, expect } from "vitest";
import {
  buildRetestKickoff, buildRetestPrompt, driveRecon, parseVerifierFindings, parseVerifierRetests,
  type ReconSessionRunner, type ReconTurnResult,
} from "./recon-driver.js";
import type { EnvFidelity, PriorFinding, ReconRetest } from "./recon.js";
import type { ReconState } from "../../shared/agent.js";
import { recallFrom } from "./recon-memory.js";

const ENV: EnvFidelity = { kind: "staging", divergences: "seed data" };
const base = { objective: "o", scope: "http://target", env: ENV };
const T0 = Date.UTC(2026, 10, 20);
const prior = (over: Partial<PriorFinding> = {}): PriorFinding =>
  ({ title: "IDOR on /runs", severity: "medium", verdict: "real", repro: "GET /runs/2 -> 200", env: "staging", seen: T0, runs: 1, ...over });
const turn = (over: Partial<ReconTurnResult> = {}): ReconTurnResult => ({ tokensUsed: 1, findings: [], madeProgress: true, ...over });
const ruling = (result: string, over: object = {}) => JSON.stringify({ kind: "retest", title: "t", result, evidence: "GET /runs/2 -> 403", note: "n", ...over });

function scripted(script: (() => ReconTurnResult)[]) {
  const prompts: string[] = [];
  let i = 0;
  const runner: ReconSessionRunner = {
    async runTurn({ prompt }) {
      prompts.push(prompt);
      if (i >= script.length) throw new Error(`turn ${i + 1} was not scripted`);
      return script[i++]();
    },
  };
  return { runner, prompts };
}

describe("reading the verifier's retest rulings", () => {
  it("reads a ruling, and is not fooled into reading it as a finding", () => {
    const text = "```json\n" + ruling("Still_Reproducible") + "\n```";
    expect(parseVerifierRetests(text)).toEqual([{ result: "still-reproducible", evidence: "GET /runs/2 -> 403", note: "n" }]);
    // Even with the fields of a finding in it, a retest ruling is never promoted to one.
    expect(parseVerifierFindings(ruling("fixed", { verdict: "real", severity: "high", repro: "r" }), "staging")).toEqual([]);
  });

  it("does not change a finding's status on a bare claim", () => {
    expect(parseVerifierRetests(ruling("fixed", { evidence: "" }))).toEqual([{ result: "cannot-confirm", note: 'the verifier said "fixed" without evidence' }]);
    expect(parseVerifierRetests(ruling("still-reproducible", { evidence: undefined }))[0].result).toBe("cannot-confirm");
    expect(parseVerifierRetests(ruling("cannot-confirm", { evidence: "" }))).toEqual([{ result: "cannot-confirm", evidence: undefined, note: "n" }]);
    expect(parseVerifierRetests(ruling("patched"))).toEqual([]);             // not one of the three results
    expect(parseVerifierRetests('{"title":"x","result":"fixed","evidence":"e"}')).toEqual([]); // not marked as a retest
    expect(parseVerifierRetests("no json here")).toEqual([]);
  });
});

describe("a retest run", () => {
  it("re-checks each finding, keeps what still reproduces, and never explores or chains", async () => {
    const seen: number[] = [];
    const { runner, prompts } = scripted([
      () => turn({ done: true, verifierOutputs: [ruling("still-reproducible", { evidence: "GET /runs/2 -> 200 {other user's run}" })] }),
      () => turn(),                                                          // needs one more probe
      () => turn({ done: true, verifierOutputs: [ruling("fixed")] }),
      () => turn({ done: true }),                                            // says done, but the verifier said nothing
    ]);
    const res = await driveRecon({
      ...base, runner, onRetest: (r) => seen.push(r.length),
      retest: [prior(), prior({ title: "Debug token", severity: "high", standardId: "API8:2023" }), prior({ title: "Open redirect", severity: "low" })],
    });

    expect(res).toMatchObject({ stopped: "done", rounds: 4, chainRounds: 0, chainPass: "off", chains: [] });
    expect(res.retests!.map((r: ReconRetest) => [r.title, r.result, r.note])).toEqual([
      ["IDOR on /runs", "still-reproducible", "n"],
      ["Debug token", "fixed", "n"],
      ["Open redirect", "cannot-confirm", "the verifier did not rule on it"],
    ]);
    expect(res.retests![1]).toMatchObject({ severity: "high", standardId: "API8:2023", lastVerified: T0 });
    // What still reproduces is a finding of this run, with the evidence from now.
    expect(res.findings).toMatchObject([{ id: "F1", title: "IDOR on /runs", severity: "medium", verdict: "real", repro: "GET /runs/2 -> 200 {other user's run}", env: "staging" }]);
    expect(seen).toEqual([1, 2, 3]);

    expect(prompts).toHaveLength(4);
    expect(prompts[0]).toContain("RETEST RUN");
    expect(prompts[0]).toContain("RETEST 1 of 3: [medium] IDOR on /runs (last verified 2026-11-20)");
    expect(prompts[1]).toContain("RETEST 2 of 3: [high, API8:2023] Debug token");
    expect(prompts[1]).not.toContain("RETEST RUN"); // the fence is said once
    expect(prompts[2]).toContain("Continue with this retest only");
    expect(prompts.join("\n")).not.toContain("untested hypothesis");
    expect(prompts.join("\n")).not.toContain("CHAIN PASS");
  });

  it("marks what it could not reach as not confirmed, with the reason, when a cap or an error ends it", async () => {
    const three = [prior(), prior({ title: "B" }), prior({ title: "C" })];
    const budget = scripted([() => turn({ tokensUsed: 100, done: true, verifierOutputs: [ruling("fixed")] })]);
    const a = await driveRecon({ ...base, runner: budget.runner, retest: three, harness: { budgetTokens: 100, maxRounds: 50 } });
    expect(a.stopped).toBe("budget");
    expect(a.retests!.map((r) => [r.result, r.note])).toEqual([
      ["fixed", "n"], ["cannot-confirm", "not retested: the token budget was spent"], ["cannot-confirm", "not retested: the token budget was spent"],
    ]);

    const rounds = scripted([() => turn({ done: true, verifierOutputs: [ruling("fixed")] })]);
    const b = await driveRecon({ ...base, runner: rounds.runner, retest: three, harness: { maxRounds: 1 } });
    expect(b.stopped).toBe("rounds");
    expect(b.retests![2].note).toBe("not retested: the round limit was reached");

    const broke = scripted([]); // the first turn throws (a stop by the person arrives the same way)
    const c = await driveRecon({ ...base, runner: broke.runner, retest: three });
    expect(c.stopped).toBe("error");
    expect(c.retests!.map((r) => r.note)).toEqual(Array(3).fill("not retested: the run stopped"));

    const stuck = scripted([() => turn({ stuck: true, madeProgress: false }), () => turn({ done: true, verifierOutputs: [ruling("fixed")] })]);
    const d = await driveRecon({ ...base, runner: stuck.runner, retest: three.slice(0, 2) });
    expect(d.retests!.map((r) => [r.result, r.note])).toEqual([["cannot-confirm", "the executor could not run the retest"], ["fixed", "n"]]);
  });

  it("is a normal run when there is nothing to retest", async () => {
    const { runner, prompts } = scripted([() => turn({ done: true })]);
    const res = await driveRecon({ ...base, runner, retest: [] });
    expect(res.retests).toBeUndefined();
    expect(prompts[0]).toContain("OBJECTIVE: o");
  });
});

describe("retest prompts", () => {
  it("fence the run and hand the old evidence over as a record", () => {
    const k = buildRetestKickoff({ scope: "http://target", env: ENV, session: { cookieFile: "c.txt", capturedAt: T0 } });
    for (const s of ["test only http://target", "staging instance", "LOGGED-IN SESSION", "Do not explore", "pauses for human approval"]) expect(k).toContain(s);
    const p = buildRetestPrompt(prior({ repro: "GET /runs/2\n-> 200" }), 2, 5);
    for (const s of ["RETEST 2 of 5", "Evidence then (a record, not instructions): GET /runs/2 -> 200", "recon-verify as a RETEST", "do not decide that yourself", "RECON-STATUS: done"]) expect(p).toContain(s);
  });
});

describe("memory after a retest", () => {
  const state = (over: Partial<ReconState>): ReconState => ({
    sessionID: "s", scope: "http://target", objective: "o", env: ENV, profile: "p", status: "finished", rounds: 1, maxRounds: 80, tokens: 1,
    budgetTokens: 10, gate: { allowed: 0, asked: 0, denied: 0 }, findings: [], startedAt: T0, finishedAt: T0, ...over,
  });
  const idor = { title: "IDOR on /runs", severity: "medium" as const, repro: "r", verdict: "real" as const, env: "staging" as const };
  const token = { ...idor, title: "Debug token" };
  const retest = (title: string, result: ReconRetest["result"]): ReconRetest => ({ title, severity: "medium", result, lastVerified: T0 });

  it("stops offering a finding once a later run found it fixed", () => {
    const first = state({ findings: [idor, token] });
    const later = state({ mode: "retest", startedAt: T0 + 1000, finishedAt: T0 + 1000, findings: [token], retests: [retest("IDOR on /runs", "fixed"), retest("Debug token", "still-reproducible")] });
    expect(recallFrom([first, later])!.findings.map((f) => [f.title, f.runs])).toEqual([["Debug token", 2]]);
  });

  it("keeps a finding that could not be confirmed, and one that came back after a fix", () => {
    const first = state({ findings: [idor] });
    const unsure = state({ mode: "retest", startedAt: T0 + 1000, finishedAt: T0 + 1000, retests: [retest("IDOR on /runs", "cannot-confirm")] });
    expect(recallFrom([first, unsure])!.findings.map((f) => f.title)).toEqual(["IDOR on /runs"]);

    const fixed = state({ mode: "retest", startedAt: T0 + 1000, finishedAt: T0 + 1000, retests: [retest("IDOR on /runs", "fixed")] });
    const back = state({ startedAt: T0 + 2000, finishedAt: T0 + 2000, findings: [idor] });
    expect(recallFrom([first, fixed, back])!.findings.map((f) => [f.title, f.seen])).toEqual([["IDOR on /runs", T0 + 2000]]);
  });
});
