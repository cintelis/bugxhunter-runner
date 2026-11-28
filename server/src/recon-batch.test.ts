import { afterEach, describe, expect, it } from "vitest";
import type { ReconState } from "../../shared/agent.js";
import { batchState, clearBatches, MIN_WORKER_BUDGET, parseTargets, resolveWorkers, startBatch, stopBatch, type BatchDeps } from "./recon-batch.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Workers that start at once and finish only when the test says so. */
function fakeWorkers(opts: { failOn?: string } = {}) {
  const started: { target: string; budget: number; sessionID: string }[] = [];
  const finish = new Map<string, (tokens?: number, stopped?: ReconState["stopped"]) => void>();
  const live = new Map<string, ReconState>();
  const stopped: string[] = [], log: string[] = [];
  const state = (sessionID: string, scope: string, over: Partial<ReconState> = {}): ReconState => ({
    sessionID, scope, objective: "o", env: { kind: "staging", divergences: "d" }, profile: "p", status: "running", rounds: 0, maxRounds: 80,
    tokens: 0, budgetTokens: 0, gate: { allowed: 0, asked: 0, denied: 0 }, findings: [], startedAt: 0, ...over,
  });
  const deps: BatchDeps = {
    async startWorker(target, budget, onFinished) {
      if (target === opts.failOn) throw new Error("no recon agent");
      const sessionID = `ses_${started.length + 1}`;
      started.push({ target, budget, sessionID });
      live.set(sessionID, state(sessionID, target, { budgetTokens: budget }));
      finish.set(target, (tokens = 1000, how = "done") => {
        const end = state(sessionID, target, { status: "finished", stopped: how, tokens, budgetTokens: budget });
        live.set(sessionID, end);
        onFinished(end);
      });
      return { sessionID };
    },
    async stopWorker(sessionID) {
      stopped.push(sessionID);
      const w = started.find((s) => s.sessionID === sessionID)!;
      finish.get(w.target)!(0, "aborted");
    },
    workerState: (sessionID) => live.get(sessionID) ?? null,
    log: (event) => log.push(event),
  };
  return { deps, started, finish, live, stopped, log };
}

afterEach(async () => {
  const b = batchState();
  if (b?.status === "running") await stopBatch(b.id);
  clearBatches();
});

const base = { directory: "/project", workerBudgetTokens: 100_000 };

describe("the targets of a batch", () => {
  it("takes a list or text, one per line, and drops repeats of the same host and port", () => {
    expect(parseTargets("https://a.example.com\n\n  b.example.com:8443 , https://A.example.com/login\r\nhttp://a.example.com"))
      .toEqual(["https://a.example.com", "b.example.com:8443", "http://a.example.com"]); // the http one is another port
    expect(parseTargets(["a.example.com", 7, "", "a.example.com:80"])).toEqual(["a.example.com"]);
  });

  it("refuses nothing, nonsense, and too many", () => {
    expect(() => parseTargets("  \n ")).toThrow(/at least one target/);
    expect(() => parseTargets(undefined)).toThrow(/at least one target/);
    expect(() => parseTargets("a.example.com\nnot a host !!")).toThrow(/Not a host or URL: not a host/);
    expect(() => parseTargets(Array.from({ length: 51 }, (_, i) => `h${i}.example.com`))).toThrow(/Up to 50/);
  });

  it("runs three at a time unless told otherwise, and never more than five", () => {
    expect([undefined, 0, "x", 1, 2, 5, 9, 2.5].map(resolveWorkers)).toEqual([3, 3, 3, 1, 2, 5, 5, 3]);
  });
});

describe("a batch", () => {
  it("keeps up to the cap going, and starts the next target as each one finishes", async () => {
    const w = fakeWorkers();
    const batch = startBatch({ ...base, targets: ["a.test", "b.test", "c.test", "d.test"], maxWorkers: 2, deps: w.deps });
    await tick();
    expect(w.started.map((s) => s.target)).toEqual(["a.test", "b.test"]);
    expect(batchState(batch.id)!.workers.map((x) => x.status)).toEqual(["running", "running", "queued", "queued"]);

    w.finish.get("b.test")!(5000);
    await tick();
    expect(w.started.map((s) => s.target)).toEqual(["a.test", "b.test", "c.test"]);
    expect(batchState(batch.id)!).toMatchObject({ status: "running", tokens: 5000 });

    w.finish.get("a.test")!(); w.finish.get("c.test")!();
    await tick();
    w.finish.get("d.test")!();
    const end = batchState(batch.id)!;
    expect(end.status).toBe("finished");
    expect(end.workers.map((x) => [x.target, x.status, x.sessionID, x.recon?.stopped])).toEqual([
      ["a.test", "finished", "ses_1", "done"], ["b.test", "finished", "ses_2", "done"], ["c.test", "finished", "ses_3", "done"], ["d.test", "finished", "ses_4", "done"],
    ]);
    expect(end.tokens).toBe(8000);
    expect(w.log).toEqual(["recon.batch.started", "recon.batch.finished"]);
  });

  it("gives each worker its own budget, on a session of its own", async () => {
    const w = fakeWorkers();
    startBatch({ ...base, targets: ["a.test", "b.test"], deps: w.deps });
    await tick();
    expect(w.started).toEqual([{ target: "a.test", budget: 100_000, sessionID: "ses_1" }, { target: "b.test", budget: 100_000, sessionID: "ses_2" }]);
  });

  it("carries on when one target cannot be started", async () => {
    const w = fakeWorkers({ failOn: "b.test" });
    const batch = startBatch({ ...base, targets: ["a.test", "b.test", "c.test"], maxWorkers: 1, deps: w.deps });
    await tick();
    w.finish.get("a.test")!();
    await tick(); await tick();
    expect(batchState(batch.id)!.workers.map((x) => [x.status, x.reason])).toEqual([["finished", undefined], ["failed", "no recon agent"], ["running", undefined]]);
    w.finish.get("c.test")!();
    expect(batchState(batch.id)!.status).toBe("finished");
  });

  it("shows a running worker's live numbers", async () => {
    const w = fakeWorkers();
    const batch = startBatch({ ...base, targets: ["a.test"], deps: w.deps });
    await tick();
    w.live.set("ses_1", { ...w.live.get("ses_1")!, rounds: 4, tokens: 1234 });
    expect(batchState(batch.id)!).toMatchObject({ tokens: 1234, workers: [{ recon: { rounds: 4, tokens: 1234 } }] });
    expect(batchState()!.id).toBe(batch.id); // the latest, when no id is given
    expect(batchState("nope")).toBeNull();
  });

  it("refuses a second batch while one is running", async () => {
    const w = fakeWorkers();
    startBatch({ ...base, targets: ["a.test"], deps: w.deps });
    expect(() => startBatch({ ...base, targets: ["b.test"], deps: w.deps })).toThrow(/already running/);
    await tick();
    w.finish.get("a.test")!();
    expect(startBatch({ ...base, targets: ["b.test"], deps: w.deps }).status).toBe("running");
  });
});

describe("the batch's token ceiling", () => {
  it("counts a running worker for its whole budget, so the ceiling holds whatever it goes on to spend", async () => {
    const w = fakeWorkers();
    // 250k in all, 100k a worker: two start on 100k each, and the third must wait for what is left.
    const batch = startBatch({ ...base, targets: ["a.test", "b.test", "c.test", "d.test"], maxWorkers: 3, totalBudgetTokens: 250_000, deps: w.deps });
    await tick();
    expect(w.started.map((s) => s.budget)).toEqual([100_000, 100_000, 50_000]);

    w.finish.get("a.test")!(30_000); // used 30k of its 100k: 70k comes back
    await tick();
    expect(w.started.map((s) => [s.target, s.budget])).toContainEqual(["d.test", 70_000]);
    w.finish.get("b.test")!(100_000); w.finish.get("c.test")!(50_000); w.finish.get("d.test")!(70_000);
    const end = batchState(batch.id)!;
    expect(end).toMatchObject({ status: "finished", budgetTokens: 250_000, tokens: 250_000 });
    expect(end.tokens).toBeLessThanOrEqual(end.budgetTokens!);
  });

  it("waits for running workers before giving up on the queue, then skips what cannot be afforded", async () => {
    const w = fakeWorkers();
    const batch = startBatch({ ...base, targets: ["a.test", "b.test", "c.test"], maxWorkers: 3, totalBudgetTokens: 110_000, deps: w.deps });
    await tick();
    expect(w.started.map((s) => s.target)).toEqual(["a.test"]); // 10k left: not enough to start b
    expect(batchState(batch.id)!.workers.map((x) => x.status)).toEqual(["running", "queued", "queued"]);

    w.finish.get("a.test")!(60_000); // 50k left: b can start, on 50k
    await tick();
    expect(w.started.map((s) => [s.target, s.budget])).toEqual([["a.test", 100_000], ["b.test", 50_000]]);
    w.finish.get("b.test")!(45_000); // 5k left: c cannot
    const end = batchState(batch.id)!;
    expect(end.status).toBe("finished");
    expect(end.workers[2]).toMatchObject({ status: "skipped", reason: "the batch's token budget was spent" });
  });

  it("refuses a ceiling too small for one worker", () => {
    expect(() => startBatch({ ...base, targets: ["a.test"], totalBudgetTokens: MIN_WORKER_BUDGET - 1, deps: fakeWorkers().deps })).toThrow(/at least 20000/);
  });
});

describe("stopping a batch", () => {
  it("stops every running worker and starts nothing more", async () => {
    const w = fakeWorkers();
    const batch = startBatch({ ...base, targets: ["a.test", "b.test", "c.test"], maxWorkers: 2, deps: w.deps });
    await tick();
    const end = (await stopBatch(batch.id))!;
    expect(w.stopped.sort()).toEqual(["ses_1", "ses_2"]);
    expect(w.started).toHaveLength(2);
    expect(end).toMatchObject({ status: "finished", stopped: true });
    expect(end.workers.map((x) => [x.status, x.recon?.stopped ?? x.reason])).toEqual([
      ["finished", "aborted"], ["finished", "aborted"], ["skipped", "the batch was stopped"],
    ]);
    expect(await stopBatch("nope")).toBeNull();
    expect((await stopBatch(batch.id))!.status).toBe("finished"); // stopping twice is harmless
  });

  it("stops a worker that was still starting when the batch was stopped", async () => {
    const w = fakeWorkers();
    const batch = startBatch({ ...base, targets: ["a.test"], deps: w.deps });
    const stopping = stopBatch(batch.id); // before the worker's session exists
    await tick(); await stopping; await tick();
    expect(w.stopped).toEqual(["ses_1"]);
    expect(batchState(batch.id)!).toMatchObject({ status: "finished", stopped: true, workers: [{ status: "finished", recon: { stopped: "aborted" } }] });
  });
});
