import { describe, expect, it } from "vitest";
import {
  chainPassNote, keptNote, memoryNote, memorySummary, pathsUsing, progressLabel, proofBadge, retestStopReason, retestSummary,
  sessionNote, sessionSummary, splitLeads, splitPaths, stoppedAt,
} from "./reconView";
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

  it("does not say none were looked for when the main loop recorded one", () => {
    const note = (chainPass: Parameters<typeof chainPassNote>[0]["chainPass"]) => chainPassNote({ status: "finished", chainPass, chains: [chain()] });
    expect(note("few-findings")).toBe("No further attack paths were looked for: it takes at least two findings to combine.");
    expect(note("off")).toContain("No further attack paths");
    expect(note("no-paths")).toContain("no other combination was proposed");
  });
});

describe("memory notes", () => {
  const memory = { runs: 2, findings: 5, paths: 1, lastRun: Date.UTC(2026, 10, 20) };

  it("sums up what is remembered about a target", () => {
    expect(memorySummary(memory)).toBe("2 earlier runs, 5 findings, 1 attack path (last 2026-11-20)");
    expect(memorySummary({ ...memory, runs: 1, findings: 1, paths: 0 })).toBe("1 earlier run, 1 finding (last 2026-11-20)");
  });

  it("says when a run started from memory, and when it was not kept", () => {
    expect(memoryNote({})).toBeNull();
    expect(memoryNote({ memory })).toContain("Started from 2 earlier runs");
    expect(keptNote({ status: "running", kept: undefined })).toBeNull();
    expect(keptNote({ status: "finished", kept: "saved" })).toBeNull();
    expect(keptNote({ status: "finished", kept: undefined })).toBeNull();
    expect(keptNote({ status: "finished", kept: "pending" })).toContain("vault is locked");
    expect(keptNote({ status: "finished", kept: "off" })).toContain("needs the vault");
  });
});

describe("session notes", () => {
  const at = Date.UTC(2026, 10, 28, 9, 10);

  it("sums up a captured session, and says when a cookie has run out", () => {
    expect(sessionSummary({ capturedAt: at, cookies: 6, authorization: true }, at)).toBe("captured 2026-11-28 09:10 UTC: 6 cookies and the Authorization header");
    expect(sessionSummary({ capturedAt: at, cookies: 1, authorization: false, firstExpiry: at + 3_600_000 }, at)).toBe("captured 2026-11-28 09:10 UTC: 1 cookie; first cookie expires 2026-11-28 10:10 UTC");
    expect(sessionSummary({ capturedAt: at, cookies: 1, authorization: false, firstExpiry: at - 1 }, at)).toContain("a cookie has expired, capture it again");
  });

  it("says when a run was tested logged in", () => {
    expect(sessionNote({})).toBeNull();
    expect(sessionNote({ session: { capturedAt: at, cookies: 2, authorization: false } })).toBe("Tested with a logged-in session (2 cookies, captured 2026-11-28 09:10 UTC).");
  });
});

describe("retest notes", () => {
  const r = (result: "still-reproducible" | "fixed" | "cannot-confirm") => ({ title: "t", severity: "low" as const, result, lastVerified: 0 });

  it("counts the outcomes, leaving out the ones with none", () => {
    expect(retestSummary([r("fixed"), r("still-reproducible"), r("still-reproducible"), r("cannot-confirm")])).toBe("2 still reproducible, 1 fixed, 1 could not be confirmed");
    expect(retestSummary([r("fixed")])).toBe("1 fixed");
    expect(retestSummary([])).toBe("nothing retested yet");
    expect(retestSummary(undefined)).toBe("nothing retested yet");
  });

  it("words the end of a retest run as a retest, and leaves a normal run alone", () => {
    expect(retestStopReason({ mode: "retest", stopped: "done" })).toBe("every remembered finding was retested");
    expect(retestStopReason({ mode: "retest", stopped: "budget" })).toBeNull();
    expect(retestStopReason({ stopped: "done" })).toBeNull();
  });
});

describe("proofBadge", () => {
  it("says how the quotes fared, and nothing for a finding from before they were checked", () => {
    expect(proofBadge("quoted")).toMatchObject({ text: "evidence matched", kind: "ok" });
    expect(proofBadge("unmatched")).toMatchObject({ text: "evidence not matched", kind: "warn" });
    expect(proofBadge("unmatched")!.title).toContain("did not return");
    expect(proofBadge("unquoted")).toMatchObject({ text: "no quotes", kind: "none" });
    expect(proofBadge(undefined)).toBeNull();
  });
});

describe("splitLeads", () => {
  it("counts what is open and what was followed or closed", () => {
    expect(splitLeads([{ status: "open" }, { status: "closed" }, { status: "open" }])).toEqual({ open: 2, closed: 1 });
    expect(splitLeads(undefined)).toEqual({ open: 0, closed: 0 });
  });
});
