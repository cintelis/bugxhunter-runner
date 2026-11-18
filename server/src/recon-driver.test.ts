import { describe, it, expect } from "vitest";
import {
  reconGateDecision, extractReconCommand, ReconRun, buildReconKickoff, driveRecon,
  type ReconTurnResult, type ReconSessionRunner,
} from "./recon-driver.js";
import { modelFor, type ReconFinding, type EnvFidelity } from "./recon.js";

const ENV: EnvFidelity = { kind: "local", divergences: "runs without QUANTUM_SHARED", nonProdSettings: ["QUANTUM_SHARED"] };
const finding = (over: Partial<ReconFinding> = {}): ReconFinding =>
  ({ title: "t", severity: "medium", repro: "r", verdict: "real", env: "local", ...over });

describe("reconGateDecision — risk-tier gate", () => {
  it("defers bash to classifyCommand", () => {
    expect(reconGateDecision({ tool: "bash", command: "curl -s http://t/api" })).toBe("allow");
    expect(reconGateDecision({ tool: "bash", command: "curl -X DELETE http://t/api/1" })).toBe("ask");
  });
  it("asks when a bash permission carries no command", () => {
    expect(reconGateDecision({ tool: "bash" })).toBe("ask");
  });
  it("allows plain reads, asks on mutating/outbound tools", () => {
    expect(reconGateDecision({ tool: "read" })).toBe("allow");
    expect(reconGateDecision({ tool: "grep" })).toBe("allow");
    expect(reconGateDecision({ tool: "edit" })).toBe("ask");
    expect(reconGateDecision({ tool: "write" })).toBe("ask");
    expect(reconGateDecision({ tool: "webfetch" })).toBe("ask");
    expect(reconGateDecision({ tool: "something-new" })).toBe("ask"); // fail closed
  });
});

describe("extractReconCommand — tolerant command extraction", () => {
  it("finds the command in the various shapes OpenCode uses", () => {
    expect(extractReconCommand({ command: "ls" })).toBe("ls");
    expect(extractReconCommand({ metadata: { command: "ls -la" } })).toBe("ls -la");
    expect(extractReconCommand({ input: { command: "whoami" } })).toBe("whoami");
    expect(extractReconCommand({ tool: { input: { command: "id" } } })).toBe("id");
    expect(extractReconCommand({ pattern: "nmap -sV t" })).toBe("nmap -sV t");
    expect(extractReconCommand({ input: "curl t" })).toBe("curl t");
  });
  it("returns undefined when there is nothing to extract", () => {
    expect(extractReconCommand({ foo: 1 })).toBeUndefined();
    expect(extractReconCommand(null)).toBeUndefined();
  });
});

describe("ReconRun — run state", () => {
  it("tracks budget and reports exhaustion", () => {
    const run = new ReconRun({ budgetTokens: 100 });
    run.recordUsage(40);
    expect(run.budgetRemaining()).toBe(60);
    expect(run.outOfBudget()).toBe(false);
    run.recordUsage(70);
    expect(run.outOfBudget()).toBe(true);
  });
  it("has no budget when the harness sets none", () => {
    expect(new ReconRun({}).budgetRemaining()).toBeUndefined();
    expect(new ReconRun({}).outOfBudget()).toBe(false);
  });
  it("caps rounds", () => {
    const run = new ReconRun({ maxRounds: 2 });
    run.recordRound();
    expect(run.outOfRounds()).toBe(false);
    run.recordRound();
    expect(run.outOfRounds()).toBe(true);
  });
  it("keeps confirmed findings, drops rejected, and reports the worst severity", () => {
    const run = new ReconRun({});
    run.addFindings([finding({ severity: "low" }), finding({ severity: "high" }), finding({ verdict: "rejected", severity: "critical" })]);
    expect(run.findings).toHaveLength(2);
    expect(run.highestSeverity()).toBe("high");
  });
});

describe("buildReconKickoff", () => {
  it("embeds the scope fence, env fidelity, objective, and the verify hand-off", () => {
    const k = buildReconKickoff({ objective: "find authz bugs", scope: "http://quantum-local:8765", env: ENV });
    expect(k).toContain("http://quantum-local:8765");
    expect(k).toContain("local instance");
    expect(k).toContain("QUANTUM_SHARED");
    expect(k).toContain("find authz bugs");
    expect(k).toContain("recon-verify");
    expect(k).toContain("config-dependent");
  });
});

/** A fake session runner that replays a script and records the model each turn ran on. */
function fakeRunner(script: ReconTurnResult[]): { runner: ReconSessionRunner; models: string[] } {
  const models: string[] = [];
  let i = 0;
  return {
    models,
    runner: {
      async runTurn({ model }) { models.push(model); return script[Math.min(i++, script.length - 1)]; },
    },
  };
}
const turn = (over: Partial<ReconTurnResult> = {}): ReconTurnResult =>
  ({ tokensUsed: 1, findings: [], madeProgress: true, ...over });

describe("driveRecon — the loop", () => {
  const base = { objective: "o", scope: "http://t", env: ENV };

  it("stops 'done' and returns the findings when the executor finishes", async () => {
    const { runner } = fakeRunner([turn({ findings: [finding()], done: true })]);
    const res = await driveRecon({ ...base, runner });
    expect(res.stopped).toBe("done");
    expect(res.findings).toHaveLength(1);
  });

  it("stops 'budget' when the token cap is hit", async () => {
    const { runner } = fakeRunner([turn({ tokensUsed: 500 })]);
    const res = await driveRecon({ ...base, runner, harness: { budgetTokens: 100 } });
    expect(res.stopped).toBe("budget");
  });

  it("stops 'rounds' when the round cap is hit", async () => {
    const { runner } = fakeRunner([turn()]);
    const res = await driveRecon({ ...base, runner, harness: { maxRounds: 3 } });
    expect(res.stopped).toBe("rounds");
    expect(res.rounds).toBe(3);
  });

  it("stops 'idle' when a turn makes no progress and isn't stuck", async () => {
    const { runner } = fakeRunner([turn({ madeProgress: false })]);
    const res = await driveRecon({ ...base, runner });
    expect(res.stopped).toBe("idle");
  });

  it("escalates the executor model after it's been stuck", async () => {
    const { runner, models } = fakeRunner([turn({ stuck: true })]);
    await driveRecon({ ...base, runner, harness: { maxRounds: 4, budgetTokens: 1e9 } });
    // attempts 0,1 run on the executor model; from the 3rd turn (attempts>=2) it escalates.
    expect(models[0]).toBe(modelFor("executor"));
    expect(models[2]).toBe(modelFor("escalate"));
  });
});
