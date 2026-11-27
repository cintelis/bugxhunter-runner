import { describe, it, expect } from "vitest";
import { ReconRun, applyChainRules, driveRecon, parseChainProposal, parseVerifierChains, parseVerifierFindings } from "./recon-driver.js";
import {
  CHAIN_PASS_DEFAULTS, parseReconHarness, resolveChainPass,
  type EnvFidelity, type ReconChain, type ReconFinding,
} from "./recon.js";

const ENV: EnvFidelity = { kind: "staging", divergences: "seed data" };
const finding = (over: Partial<ReconFinding> = {}): ReconFinding =>
  ({ title: "t", severity: "medium", repro: "r", verdict: "real", env: "staging", ...over });

/** Three kept findings, numbered as a run numbers them: F1 low, F2 medium (config-dependent), F3 high. */
function kept(): ReconFinding[] {
  const run = new ReconRun();
  run.addFindings([
    finding({ title: "User enumeration", severity: "low" }),
    finding({ title: "Debug token endpoint", severity: "medium", verdict: "config-dependent", prodCaveat: "Re-test with DEBUG off." }),
    finding({ title: "IDOR on /runs", severity: "high" }),
  ]);
  return run.findings;
}

describe("finding and path ids", () => {
  it("numbers the findings a run keeps, skipping rejected ones", () => {
    const run = new ReconRun();
    const first = finding({ title: "a" });
    run.addFindings([first, finding({ title: "no", verdict: "rejected" })]);
    run.addFindings([finding({ title: "b" })]);
    expect(run.findings.map((f) => [f.id, f.title])).toEqual([["F1", "a"], ["F2", "b"]]);
    expect(first.id).toBe("F1"); // set on the finding itself: the run's live view holds the same object
  });

  it("numbers attack paths, and a run without the pass reports none", async () => {
    const run = new ReconRun();
    const chain: ReconChain = { title: "x", severity: "high", verdict: "real", impact: "i", links: ["F1"], steps: [{ action: "a", evidence: "e" }, { action: "b", evidence: "e" }], status: "demonstrated", env: "staging" };
    run.addChains([{ ...chain }, { ...chain }]);
    expect(run.chains.map((c) => c.id)).toEqual(["P1", "P2"]);

    const res = await driveRecon({
      objective: "o", scope: "http://target", env: ENV,
      runner: { async runTurn() { return { tokensUsed: 1, findings: [finding()], madeProgress: true, done: true }; } },
    });
    expect(res.findings[0].id).toBe("F1");
    expect(res.chains).toEqual([]);
  });
});

describe("chain pass settings", () => {
  it("fills in the defaults and takes overrides", () => {
    expect(resolveChainPass()).toEqual(CHAIN_PASS_DEFAULTS);
    expect(resolveChainPass({ enabled: false, maxCandidates: 1 })).toEqual({ ...CHAIN_PASS_DEFAULTS, enabled: false, maxCandidates: 1 });
  });

  it("reads them from a harness and drops values outside the limits", () => {
    expect(parseReconHarness({ chainPass: { enabled: false, maxCandidates: 2, maxRoundsPerChain: 4, reservePercent: 0 } })?.chainPass)
      .toEqual({ enabled: false, maxCandidates: 2, maxRoundsPerChain: 4, reservePercent: 0 });
    expect(parseReconHarness({ chainPass: { maxCandidates: 50, maxRoundsPerChain: 0, reservePercent: 90, enabled: "yes" } })).toBeUndefined();
    expect(parseReconHarness({ maxRounds: 5, chainPass: "on" })).toEqual({ maxRounds: 5 });
  });
});

describe("parseChainProposal", () => {
  const findings = kept();

  it("reads the proposed paths, keeping only links that name a finding of the run", () => {
    const text = 'Two paths.\n```json\n{"paths":[' +
      '{"title":"Takeover","goal":"Read any user\'s runs","links":["F1","f3","F9",3],"steps":["List users","Take a user id","GET /runs/<id>"],"unproven":3},' +
      '{"goal":"Mint a token","findings":[2],"steps":[{"action":"Call /debug/token"},{"step":"Use it on /admin"}]}' +
      ']}\n```';
    expect(parseChainProposal(text, findings, 3)).toEqual([
      { title: "Takeover", goal: "Read any user's runs", links: ["F1", "F3"], steps: ["List users", "Take a user id", "GET /runs/<id>"], unproven: 3 },
      { title: "Mint a token", goal: "Mint a token", links: ["F2"], steps: ["Call /debug/token", "Use it on /admin"] },
    ]);
  });

  it("takes path objects on their own, and no more than the cap", () => {
    const path = (n: number) => JSON.stringify({ goal: `g${n}`, links: ["F1"], steps: ["a", "b"] });
    expect(parseChainProposal(`[${path(1)}, ${path(2)}, ${path(3)}]`, findings, 2).map((c) => c.goal)).toEqual(["g1", "g2"]);
  });

  it("drops a path with one step, with no goal, or that builds on no finding of the run", () => {
    expect(parseChainProposal('{"goal":"g","links":["F1"],"steps":["only one"]}', findings, 3)).toEqual([]);
    expect(parseChainProposal('{"links":["F1"],"steps":["a","b"]}', findings, 3)).toEqual([]);
    expect(parseChainProposal('{"goal":"g","links":["F7","nope"],"steps":["a","b"]}', findings, 3)).toEqual([]);
    expect(parseChainProposal('{"goal":"g","links":["F1"],"steps":["a","b"]}', [], 3)).toEqual([]);
    expect(parseChainProposal("I could not find a path worth trying.", findings, 3)).toEqual([]);
  });

  it("ignores an unproven step that is not one of the steps", () => {
    const [c] = parseChainProposal('{"goal":"g","links":["F1"],"steps":["a","b"],"unproven":5}', findings, 3);
    expect(c).not.toHaveProperty("unproven");
  });
});

describe("parseVerifierChains", () => {
  const findings = kept();
  const verdict = (over: Record<string, unknown> = {}) => "```json\n" + JSON.stringify({
    kind: "chain", title: "Read any user's runs", verdict: "real", severity: "high", standard_id: "API1:2023",
    impact: "Any signed-in user reads every other user's runs", links: ["F1", "F3"],
    steps: [
      { action: "List users", evidence: "GET /users -> 200 [..]" },
      { action: "Read another user's run", evidence: "GET /runs/2 as user 1 -> 200 {..}" },
    ],
    ...over,
  }) + "\n```";

  it("reads a demonstrated path with its steps, links and environment", () => {
    expect(parseVerifierChains(verdict(), "staging", findings)).toEqual([{
      title: "Read any user's runs", severity: "high", verdict: "real", standardId: "API1:2023", prodCaveat: undefined,
      impact: "Any signed-in user reads every other user's runs", links: ["F1", "F3"],
      steps: [
        { action: "List users", evidence: "GET /users -> 200 [..]" },
        { action: "Read another user's run", evidence: "GET /runs/2 as user 1 -> 200 {..}" },
      ],
      status: "demonstrated", env: "staging",
    }]);
  });

  it("is not also read as a finding, and a finding is not read as a path", () => {
    const both = verdict({ repro: "GET /runs/2 -> 200" }) + '\n{"title":"Plain","verdict":"real","severity":"low","repro":"x"}';
    expect(parseVerifierFindings(both, "staging").map((f) => f.title)).toEqual(["Plain"]);
    expect(parseVerifierChains(both, "staging", findings).map((c) => c.title)).toEqual(["Read any user's runs"]);
  });

  it("makes a path with an unevidenced step partial, stopped at that step", () => {
    const [c] = parseVerifierChains(verdict({ steps: [{ action: "a", evidence: "e" }, { action: "b" }, "c"] }), "staging", findings);
    expect(c).toMatchObject({ status: "partial", blockedAt: 2, blockedWhy: "no evidence for this step" });
  });

  it("keeps what the verifier said stopped a partial path", () => {
    const [c] = parseVerifierChains(verdict({ status: "partial", blocked_at: 2, blocked_why: "The write was not approved" }), "staging", findings);
    expect(c).toMatchObject({ status: "partial", blockedAt: 2, blockedWhy: "The write was not approved" });
  });

  it("makes a path config-dependent when a finding it uses is", () => {
    const [c] = parseVerifierChains(verdict({ links: ["F2", "F3"] }), "staging", findings);
    expect(c).toMatchObject({ verdict: "config-dependent", prodCaveat: "Re-test with DEBUG off." });
  });

  it("never rates a demonstrated path below the worst finding it uses", () => {
    expect(parseVerifierChains(verdict({ severity: "low" }), "staging", findings)[0].severity).toBe("high");     // F3 is high
    expect(parseVerifierChains(verdict({ severity: "critical" }), "staging", findings)[0].severity).toBe("critical");
    expect(parseVerifierChains(verdict({ severity: "low", links: ["F1"] }), "staging", findings)[0].severity).toBe("low");
  });

  it("drops a rejected path and anything it cannot vouch for", () => {
    expect(parseVerifierChains(verdict({ verdict: "rejected" }), "staging", findings)).toEqual([]);
    expect(parseVerifierChains(verdict({ severity: "severe" }), "staging", findings)).toEqual([]);
    expect(parseVerifierChains(verdict({ links: ["F8"] }), "staging", findings)).toEqual([]);       // names no finding of the run
    expect(parseVerifierChains(verdict({ steps: [{ action: "one", evidence: "e" }] }), "staging", findings)).toEqual([]);
    expect(parseVerifierChains(verdict({ impact: "" }), "staging", findings)).toEqual([]);
    expect(parseVerifierChains("This chain holds, severity high.", "staging", findings)).toEqual([]);
    expect(parseVerifierChains(verdict().slice(0, -8), "staging", findings)).toEqual([]);           // truncated JSON
  });
});

describe("applyChainRules", () => {
  it("leaves the severity of a partial path as the verifier gave it", () => {
    const findings = kept();
    const partial: ReconChain = {
      title: "x", severity: "low", verdict: "real", impact: "i", links: ["F3"], env: "staging",
      steps: [{ action: "a", evidence: "e" }, { action: "b" }], status: "partial", blockedAt: 2, blockedWhy: "declined",
    };
    expect(applyChainRules(partial, findings)).toMatchObject({ severity: "low", status: "partial", blockedAt: 2, blockedWhy: "declined" });
  });
});
