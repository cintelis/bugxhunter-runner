import { describe, it, expect } from "vitest";
import {
  buildOpenLeadsPrompt, buildPriorBlock, buildReconContinue, buildReconKickoff, driveRecon, parseLeads, ReconRun, RECON_CONTINUE,
  type ReconSessionRunner, type ReconTurnResult,
} from "./recon-driver.js";
import type { EnvFidelity, ReconFinding, ReconLead } from "./recon.js";
import type { ReconState } from "../../shared/agent.js";
import { recallFrom } from "./recon-memory.js";

const ENV: EnvFidelity = { kind: "staging", divergences: "seed data" };
const base = { objective: "o", scope: "http://target", env: ENV };
const turn = (over: Partial<ReconTurnResult> = {}): ReconTurnResult => ({ tokensUsed: 1, findings: [], madeProgress: true, ...over });
const finding = (over: Partial<ReconFinding> = {}): ReconFinding => ({ title: "t", severity: "medium", repro: "r", verdict: "real", env: "staging", ...over });

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

describe("reading lead lines", () => {
  it("reads the leads a turn opened and the ones it closed, whatever the markdown around them", () => {
    const text = [
      "I looked at /api/users.",
      "RECON-LEAD: /api/users/export takes an undocumented `format` parameter",
      "- **RECON-LEAD:** the 500 on /search leaks a stack trace with a file path**",
      "> RECON-LEAD-DONE: L2 - it is only the public docs page",
      "RECON-LEAD-DONE: 3",
      "recon-lead: lower case counts too",
      "This sentence mentions RECON-LEAD: in the middle and is not a lead line.",
      "RECON-STATUS: continue",
    ].join("\n");
    expect(parseLeads(text)).toEqual({
      opened: ["/api/users/export takes an undocumented `format` parameter", "the 500 on /search leaks a stack trace with a file path", "lower case counts too"],
      closed: [{ id: "L2", outcome: "it is only the public docs page" }, { id: "L3", outcome: undefined }],
    });
    expect(parseLeads("")).toEqual({ opened: [], closed: [] });
  });

  it("takes a bounded number per turn, each of bounded length", () => {
    const many = Array.from({ length: 20 }, (_, i) => `RECON-LEAD: lead number ${i} ${"x".repeat(400)}`).join("\n");
    const { opened } = parseLeads(many);
    expect(opened).toHaveLength(8);
    expect(opened[0].length).toBeLessThanOrEqual(241);
  });
});

describe("the run's list of leads", () => {
  it("numbers new leads, skips repeats, and closes the ones named", () => {
    const run = new ReconRun();
    expect(run.noteLeads("RECON-LEAD: hidden format parameter\nRECON-LEAD: stack trace on /search")).toBe(true);
    expect(run.noteLeads("RECON-LEAD:  Hidden   FORMAT parameter")).toBe(false); // the same lead again
    expect(run.noteLeads("nothing here")).toBe(false);
    expect(run.noteLeads("RECON-LEAD-DONE: L1 it is an XXE, handed to the verifier\nRECON-LEAD-DONE: L9 no such lead\nRECON-LEAD: a third")).toBe(true);
    expect(run.leads.map((l: ReconLead) => [l.id, l.status, l.outcome])).toEqual([
      ["L1", "closed", "it is an XXE, handed to the verifier"], ["L2", "open", undefined], ["L3", "open", undefined],
    ]);
    expect(run.noteLeads("RECON-LEAD-DONE: L1 again")).toBe(false); // already closed
    expect(run.openLeads.map((l) => l.id)).toEqual(["L2", "L3"]);
  });

  it("stops growing at its cap", () => {
    const run = new ReconRun();
    for (let i = 0; i < 12; i++) run.noteLeads(Array.from({ length: 8 }, (_, j) => `RECON-LEAD: lead ${i}-${j}`).join("\n"));
    expect(run.leads).toHaveLength(40);
  });
});

describe("leads in the main loop", () => {
  it("gives open leads back each round, oldest first, and tells the panel when the list changes", async () => {
    const seen: string[][] = [];
    const { runner, prompts } = scripted([
      () => turn({ text: "RECON-LEAD: hidden format parameter\nRECON-LEAD: stack trace on /search\nRECON-STATUS: continue" }),
      () => turn({ text: "RECON-LEAD-DONE: L1 nothing there\nRECON-STATUS: continue" }),
      () => turn({ text: "RECON-LEAD-DONE: L2 leaks only a framework path\nRECON-STATUS: done", done: true }),
    ]);
    const res = await driveRecon({ ...base, runner, onLeads: (l) => seen.push(l.filter((x) => x.status === "open").map((x) => x.id)) });

    expect(prompts[0]).toContain('write a line "RECON-LEAD: <what it is and where>"');
    expect(prompts[1]).toContain("Open leads (you noted these and have not followed them; oldest first):\nL1 hidden format parameter\nL2 stack trace on /search");
    expect(prompts[1]).toContain("Follow the oldest one");
    expect(prompts[2]).toContain("L2 stack trace on /search");
    expect(prompts[2]).not.toContain("L1 hidden format parameter"); // closed leads are not repeated
    expect(seen).toEqual([["L1", "L2"], ["L2"], []]);
    expect(res).toMatchObject({ stopped: "done", rounds: 3 });
    expect(res.leads.map((l) => [l.id, l.status, l.round])).toEqual([["L1", "closed", 1], ["L2", "closed", 1]]);
  });

  it("sends the executor back to its open leads once when it says it is done, then takes its word", async () => {
    const { runner, prompts } = scripted([
      () => turn({ text: "RECON-LEAD: an admin path in robots.txt\nRECON-STATUS: done", done: true }),
      () => turn({ text: "RECON-LEAD: and another thing\nRECON-STATUS: done", done: true }), // still open, but it was asked once
    ]);
    const res = await driveRecon({ ...base, runner });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("leads you noted yourself are still open");
    expect(prompts[1]).toContain("L1 an admin path in robots.txt");
    expect(res).toMatchObject({ stopped: "done", rounds: 2 });
    expect(res.leads.filter((l) => l.status === "open")).toHaveLength(2);
  });

  it("does not go back for leads when the budget or the rounds are spent", async () => {
    const a = scripted([() => turn({ tokensUsed: 100, text: "RECON-LEAD: x marks the spot\nRECON-STATUS: done", done: true })]);
    expect(await driveRecon({ ...base, runner: a.runner, harness: { budgetTokens: 100, maxRounds: 50 } })).toMatchObject({ stopped: "done", rounds: 1 });
    const b = scripted([() => turn({ text: "RECON-LEAD: x marks the spot\nRECON-STATUS: done", done: true })]);
    expect(await driveRecon({ ...base, runner: b.runner, harness: { maxRounds: 1 } })).toMatchObject({ stopped: "done", rounds: 1 });
  });

  it("leaves a run with no leads exactly as it was", async () => {
    const { runner, prompts } = scripted([() => turn(), () => turn({ done: true })]);
    const res = await driveRecon({ ...base, runner });
    expect(prompts[1]).toBe(RECON_CONTINUE);
    expect(res.leads).toEqual([]);
  });
});

describe("lead prompts", () => {
  const leads: ReconLead[] = [
    { id: "L1", text: "closed one", status: "closed", round: 1 },
    { id: "L2", text: "hidden format parameter", status: "open", round: 1 },
  ];

  it("come after what the findings unlock, and before a fresh hypothesis", () => {
    const p = buildReconContinue([finding({ id: "F1", title: "IDOR" })], [], leads);
    expect(p.indexOf("Verified so far")).toBeLessThan(p.indexOf("Open leads"));
    expect(p.indexOf("Open leads")).toBeLessThan(p.indexOf("next untested hypothesis"));
    expect(p).toContain("If nothing follows from the findings or the leads");
    expect(p).not.toContain("closed one");
    expect(buildReconContinue([], [], leads)).toMatch(/^Continue\.\n\nOpen leads/);
    expect(buildReconContinue([], [], [leads[0]])).toBe(RECON_CONTINUE); // nothing open
    expect(buildOpenLeadsPrompt(leads)).toContain("L2 hidden format parameter");
  });

  it("carry the last run's open leads into the next run's kickoff", () => {
    const prior = { runs: 1, lastRun: Date.UTC(2026, 10, 20), findings: [], paths: [], leads: ["hidden format\nparameter on /export"] };
    expect(buildPriorBlock(prior)).toContain("Leads the last run noted and never followed:\n- hidden format parameter on /export");
    expect(buildReconKickoff({ ...base, prior })).toContain("FROM EARLIER RUNS"); // leads alone are worth the block
  });
});

describe("memory of leads", () => {
  const T0 = Date.UTC(2026, 10, 20);
  const state = (over: Partial<ReconState>): ReconState => ({
    sessionID: "s", scope: "http://target", objective: "o", env: ENV, profile: "p", status: "finished", rounds: 1, maxRounds: 80, tokens: 1,
    budgetTokens: 10, gate: { allowed: 0, asked: 0, denied: 0 }, findings: [], startedAt: T0, finishedAt: T0, ...over,
  });
  const lead = (id: string, text: string, status: "open" | "closed"): ReconLead => ({ id, text, status, round: 1 });

  it("recalls only what the newest exploring run left open", () => {
    const old = state({ leads: [lead("L1", "from the old run", "open")] });
    const newer = state({ startedAt: T0 + 1000, finishedAt: T0 + 1000, leads: [lead("L1", "followed", "closed"), lead("L2", "still open", "open")] });
    const retest = state({ mode: "retest", startedAt: T0 + 2000, finishedAt: T0 + 2000, retests: [] });
    expect(recallFrom([old, newer, retest])!.leads).toEqual(["still open"]);
    expect(recallFrom([old])!.leads).toEqual(["from the old run"]);
    expect(recallFrom([state({})])).not.toHaveProperty("leads");
  });
});
