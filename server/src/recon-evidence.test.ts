import { describe, it, expect } from "vitest";
import { EvidenceLog, MIN_QUOTE, normalise, readQuotes } from "./recon-evidence.js";
import {
  applyRetestProof, buildReconKickoff, buildRetestKickoff, driveRecon, parseVerifierFindings, parseVerifierRetests,
  type ReconSessionRunner, type ReconTurnResult,
} from "./recon-driver.js";
import type { EnvFidelity, PriorFinding } from "./recon.js";

describe("the evidence log", () => {
  const log = new EvidenceLog();
  log.add('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\n  "owner": "alice@example.com",\n  "id": 2\n}');
  log.add("   ");

  it("finds text a command really returned, however it was wrapped", () => {
    expect(log.size).toBe(1);
    expect(log.has('"owner": "alice@example.com", "id": 2')).toBe(true);
    expect(log.has('{ "owner":   "alice@example.com",\n"id": 2 }')).toBe(true);
    expect(log.has('"owner": "bob@example.com"')).toBe(false);
    expect(log.has('"OWNER": "ALICE@EXAMPLE.COM"')).toBe(false); // case is part of the evidence
  });

  it("does not let a short quote prove anything", () => {
    expect("200 OK".length).toBeLessThan(MIN_QUOTE);
    expect(log.has("200 OK")).toBe(false);
    expect(log.check(["200 OK", "id"])).toBe("unquoted");
  });

  it("rules on a set of quotes as a whole", () => {
    expect(log.check(["Content-Type: application/json"])).toBe("quoted");
    expect(log.check(["Content-Type: application/json", "200 OK"])).toBe("quoted"); // the short one is ignored
    expect(log.check(["Content-Type: application/json", '"role": "admin", "id": 1'])).toBe("unmatched");
    expect(log.check([])).toBe("unquoted");
    expect(log.check(undefined)).toBe("unquoted");
    expect(new EvidenceLog().check(["Content-Type: application/json"])).toBe("unmatched");
  });

  it("drops the oldest output once it is full, and never grows without bound", () => {
    const big = new EvidenceLog();
    for (let i = 0; i < 30; i++) big.add(`marker-number-${String(i).padStart(4, "0")} ` + "x".repeat(399_000));
    expect(big.size).toBeLessThan(30);
    expect(big.has("marker-number-0029")).toBe(true);
    expect(big.has("marker-number-0000")).toBe(false);
    const long = new EvidenceLog();
    long.add("a".repeat(500_000) + " the-tail-is-cut-off-here");
    expect(long.has("the-tail-is-cut-off-here")).toBe(false);
  });

  it("reads quotes as a handful of bounded strings", () => {
    expect(readQuotes(["a", 3, "", "  ", "b", null])).toEqual(["a", "b"]);
    expect(readQuotes("not a list")).toEqual([]);
    expect(readQuotes(Array(20).fill("q"))).toHaveLength(5);
    expect(readQuotes(["x".repeat(5000)])[0]).toHaveLength(600);
    expect(normalise("  a \n\t b  ")).toBe("a b");
  });
});

describe("quotes in the verifier's verdicts", () => {
  it("are read off a finding and a retest ruling", () => {
    const f = parseVerifierFindings('{"title":"A","verdict":"real","severity":"low","repro":"r","quotes":["GET /runs/2 -> 200", 7]}', "staging");
    expect(f[0].quotes).toEqual(["GET /runs/2 -> 200"]);
    expect(parseVerifierFindings('{"title":"A","verdict":"real","severity":"low","repro":"r"}', "staging")[0]).not.toHaveProperty("quotes");
    const r = parseVerifierRetests('{"kind":"retest","result":"fixed","evidence":"e","quotes":["HTTP/1.1 403 Forbidden"],"note":"n"}');
    expect(r).toEqual([{ result: "fixed", evidence: "e", note: "n", quotes: ["HTTP/1.1 403 Forbidden"] }]);
  });

  it("a retest ruling on text the run never received does not change the finding's status", () => {
    const fixed = { result: "fixed" as const, evidence: "e", note: "n", quotes: ["q"] };
    expect(applyRetestProof(fixed, "quoted")).toEqual({ result: "fixed", evidence: "e", note: "n", proof: "quoted" });
    expect(applyRetestProof(fixed, "unquoted")).toEqual({ result: "fixed", evidence: "e", note: "n", proof: "unquoted" });
    expect(applyRetestProof(fixed, "unmatched")).toEqual({
      result: "cannot-confirm", evidence: "e", proof: "unmatched", note: 'the verifier said "fixed", but quoted text this run\'s commands did not return',
    });
    expect(applyRetestProof({ result: "cannot-confirm", note: "n" }, "unmatched")).toEqual({ result: "cannot-confirm", note: "n", proof: "unmatched" });
    expect(applyRetestProof(fixed, undefined)).toEqual({ result: "fixed", evidence: "e", note: "n" }); // a runner that keeps no record
  });
});

describe("a retest run with a record of the output", () => {
  const ENV: EnvFidelity = { kind: "staging", divergences: "seed data" };
  const prior = (title: string): PriorFinding => ({ title, severity: "medium", verdict: "real", repro: "r", env: "staging", seen: 0, runs: 1 });
  const turn = (output: string): ReconTurnResult => ({ tokensUsed: 1, findings: [], madeProgress: true, done: true, verifierOutputs: [output] });
  const ruling = (result: string, quote: string) => JSON.stringify({ kind: "retest", result, evidence: "e", quotes: [quote], note: "n" });

  it("keeps a ruling whose quotes are in the output, and not one whose quotes are not", async () => {
    const log = new EvidenceLog();
    log.add("HTTP/1.1 403 Forbidden for /runs/2");
    const script = [turn(ruling("fixed", "HTTP/1.1 403 Forbidden")), turn(ruling("still-reproducible", "HTTP/1.1 200 OK with secrets")), turn(ruling("fixed", "HTTP/1.1 404 it is gone now"))];
    let i = 0;
    const runner: ReconSessionRunner = { runTurn: async () => script[i++], proof: (q) => log.check(q) };
    const res = await driveRecon({ objective: "o", scope: "http://target", env: ENV, runner, retest: [prior("A"), prior("B"), prior("C")] });
    expect(res.retests!.map((r) => [r.title, r.result, r.proof])).toEqual([
      ["A", "fixed", "quoted"], ["B", "cannot-confirm", "unmatched"], ["C", "cannot-confirm", "unmatched"],
    ]);
    expect(res.findings).toEqual([]); // B was not shown to still reproduce
  });
});

describe("the executor is told why to paste responses as they came back", () => {
  it("in the kickoff of a normal run and of a retest run", () => {
    const base = { objective: "o", scope: "http://target", env: { kind: "staging" as const, divergences: "d" } };
    for (const k of [buildReconKickoff(base), buildRetestKickoff(base)]) {
      expect(k).toContain("exactly as it came back, not a summary");
      expect(k).toContain("checked against what the commands of this run really returned");
    }
  });
});
