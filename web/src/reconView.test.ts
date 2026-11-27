import { describe, expect, it } from "vitest";
import { chainPassNote, pathsUsing, progressLabel, splitPaths, stoppedAt } from "./reconView";
import type { ReconChain } from "../../shared/agent";

const chain = (over: Partial<ReconChain> = {}): ReconChain => ({
  id: "P1", title: "t", severity: "high", verdict: "real", impact: "i", links: ["F1", "F2"],
  steps: [{ action: "a", evidence: "e" }, { action: "b", evidence: "e" }], status: "demonstrated", env: "staging", ...over,
});

describe("splitPaths and pathsUsing", () => {
  const chains = [chain({ id: "P1", status: "partial", links: ["F1"] }), chain({ id: "P2", links: ["F1", "F3"] }), chain({ id: "P3", links: ["F2"] })];

  it("keeps demonstrated paths apart from partial ones", () => {
    const { demonstrated, partial } = splitPaths(chains);
    expect(demonstrated.map((c) => c.id)).toEqual(["P2", "P3"]);
    expect(partial.map((c) => c.id)).toEqual(["P1"]);
    expect(splitPaths(undefined)).toEqual({ demonstrated: [], partial: [] });
  });

  it("lists the paths a finding is part of, demonstrated first", () => {
    expect(pathsUsing("F1", chains)).toEqual(["P2", "P1"]);
    expect(pathsUsing("F3", chains)).toEqual(["P2"]);
    expect(pathsUsing("F9", chains)).toEqual([]);
    expect(pathsUsing(undefined, chains)).toEqual([]); // a finding from before findings had ids
  });
});

describe("stoppedAt", () => {
  it("names the step and the reason, or just the reason", () => {
    expect(stoppedAt(chain({ status: "partial", blockedAt: 2, blockedWhy: "The write was not approved" }))).toBe("Stopped at step 2: The write was not approved");
    expect(stoppedAt(chain({ status: "partial", blockedWhy: "not shown within 3 rounds" }))).toBe("Not shown: not shown within 3 rounds");
    expect(stoppedAt(chain({ status: "partial" }))).toBe("Not shown: not shown");
  });
});

describe("progressLabel", () => {
  it("counts the main loop's rounds, then the chain pass's turns", () => {
    expect(progressLabel({ status: "running", rounds: 3, maxRounds: 80 })).toBe("round 4/80");
    expect(progressLabel({ status: "running", phase: "chains", rounds: 12, maxRounds: 80, chainRounds: 2 })).toBe("chaining findings · turn 3");
    expect(progressLabel({ status: "running", phase: "chains", rounds: 12, maxRounds: 80 })).toBe("chaining findings · turn 1");
    expect(progressLabel({ status: "finished", phase: "chains", rounds: 12, maxRounds: 80, chainRounds: 4 })).toBe("round 12/80 · 4 chaining");
    expect(progressLabel({ status: "finished", rounds: 12, maxRounds: 80, chainRounds: 0 })).toBe("round 12/80");
  });
});

describe("chainPassNote", () => {
  it("says nothing while the run is going, or when the pass recorded paths", () => {
    expect(chainPassNote({ status: "running", chainPass: undefined, chains: [] })).toBeNull();
    expect(chainPassNote({ status: "finished", chainPass: "ran", chains: [chain()] })).toBeNull();
    expect(chainPassNote({ status: "finished", chainPass: undefined, chains: undefined })).toBeNull();
  });

  it("explains each reason a finished run has no paths", () => {
    const note = (chainPass: Parameters<typeof chainPassNote>[0]["chainPass"]) => chainPassNote({ status: "finished", chainPass, chains: [] });
    expect(note("few-findings")).toContain("at least two findings");
    expect(note("off")).toContain("turned off");
    expect(note("skipped")).toContain("ended before");
    expect(note("budget")).toContain("token budget");
    expect(note("no-paths")).toContain("no combination was proposed");
    expect(note("rate-limited")).toContain("rate-limited");
    expect(note("error")).toContain("stopped early");
    expect(note("ran")).toBe("No attack path was recorded.");
  });
});
