/**
 * Concurrency mode: one supervised recon run per target, several at a time.
 *
 * A batch is a queue of targets and a cap on how many are tested at once. Each worker is
 * an ordinary recon run on a session of its own (recon-run.ts): its own gate bound to its
 * own target, its own rounds, budget, evidence, leads, memory and logged-in session. The
 * workers do not talk to each other. All this file adds is the queue, a token ceiling
 * across the workers, and one place to see and stop them.
 *
 * The coordinator is plain code. It starts a worker, waits to be told it finished, and
 * starts the next; how a worker is started and stopped is injected, so the queue can be
 * tested without OpenCode. A batch lives in the runner's memory, like a run that is still
 * going: what each worker found is kept by the worker itself, per target.
 */
import crypto from "node:crypto";
import type { ReconBatchState, ReconBatchWorker, ReconState } from "../../shared/agent.js";
import { httpError } from "./errors.js";
import { originOf } from "./recon.js";

export const BATCH_DEFAULTS = { maxWorkers: 3 } as const;
export const BATCH_LIMITS = { maxWorkers: 5, targets: 50 } as const;
/** A worker is not started on less than this: it could not finish a round. */
export const MIN_WORKER_BUDGET = 20_000;

export interface BatchDeps {
  /**
   * Open a session for `target` and start a recon run on it with this token budget. Resolves
   * with the session once the run has started; `onFinished` is called when the run ends.
   */
  startWorker(target: string, budgetTokens: number, onFinished: (state: ReconState) => void): Promise<{ sessionID: string }>;
  stopWorker(sessionID: string): Promise<unknown>;
  /** The live state of a worker's run. */
  workerState(sessionID: string): ReconState | null;
  log?(event: string, data: Record<string, unknown>): void;
}

export interface BatchStart {
  targets: readonly string[];
  /** The project folder the workers' sessions live in. */
  directory: string;
  maxWorkers?: number;
  /** Each worker's own token budget. */
  workerBudgetTokens: number;
  /** A ceiling across all workers. Absent: each worker has its own budget and that is all. */
  totalBudgetTokens?: number;
  deps: BatchDeps;
}

interface Batch { state: ReconBatchState; directory: string; deps: BatchDeps; workerBudget: number; reserved: Map<string, number>; stopping: boolean }
const batches = new Map<string, Batch>();

/**
 * The targets of a batch, from a list or from text with one per line (commas work too):
 * each one host or URL, repeats of the same host and port dropped, order kept.
 */
export function parseTargets(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\r\n,]+/) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const scope = typeof item === "string" ? item.trim() : "";
    if (!scope) continue;
    const { host, port } = originOf(scope);
    if (!host) throw httpError(400, `Not a host or URL: ${scope.slice(0, 80)}`);
    const key = `${host}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(scope);
  }
  if (!out.length) throw httpError(400, "Give at least one target, one host or URL per line.");
  if (out.length > BATCH_LIMITS.targets) throw httpError(400, `Up to ${BATCH_LIMITS.targets} targets in one batch.`);
  return out;
}

/** How many workers at once: the default, or what was asked for within the limit. */
export function resolveWorkers(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, BATCH_LIMITS.maxWorkers) : BATCH_DEFAULTS.maxWorkers;
}

const active = (w: ReconBatchWorker) => w.status === "starting" || w.status === "running";

/** Tokens the batch has spent: what finished workers used, and what running ones have used so far. */
function spent(b: Batch): number {
  let n = 0;
  for (const w of b.state.workers) {
    const live = w.status === "running" && w.sessionID ? b.deps.workerState(w.sessionID) : null;
    n += (live ?? w.recon)?.tokens ?? 0;
  }
  return n;
}

/**
 * What a new worker may be given: its own budget, or less if the total ceiling leaves
 * less. Running workers count for their whole budget, not what they have used so far, so
 * the ceiling holds whatever they go on to spend.
 */
function budgetForNext(b: Batch): number {
  const total = b.state.budgetTokens;
  if (total === undefined) return b.workerBudget;
  let committed = 0;
  for (const w of b.state.workers) {
    if (active(w)) committed += b.reserved.get(w.target) ?? 0;
    else committed += w.recon?.tokens ?? 0;
  }
  return Math.min(b.workerBudget, total - committed);
}

function finishIfDone(b: Batch): void {
  if (b.state.status !== "running" || b.state.workers.some((w) => w.status === "queued" || active(w))) return;
  b.state.status = "finished";
  b.state.finishedAt = Date.now();
  b.state.tokens = spent(b);
  const count = (s: ReconBatchWorker["status"]) => b.state.workers.filter((w) => w.status === s).length;
  b.deps.log?.("recon.batch.finished", {
    batch: b.state.id, finished: count("finished"), failed: count("failed"), skipped: count("skipped"), tokens: b.state.tokens, stopped: Boolean(b.state.stopped),
  });
}

/** Start queued targets until the cap on workers is reached, the queue is empty or the ceiling is. */
function pump(b: Batch): void {
  if (b.state.status !== "running") return;
  while (!b.stopping) {
    const next = b.state.workers.find((w) => w.status === "queued");
    if (!next || b.state.workers.filter(active).length >= b.state.maxWorkers) break;
    const budget = budgetForNext(b);
    if (budget < MIN_WORKER_BUDGET) {
      // Tokens reserved for running workers may come back when they finish under budget: wait for them.
      if (b.state.workers.some(active)) break;
      for (const w of b.state.workers) if (w.status === "queued") { w.status = "skipped"; w.reason = "the batch's token budget was spent"; }
      break;
    }
    start(b, next, budget);
  }
  finishIfDone(b);
}

function start(b: Batch, w: ReconBatchWorker, budget: number): void {
  w.status = "starting";
  b.reserved.set(w.target, budget);
  const onFinished = (state: ReconState) => {
    w.status = "finished";
    w.recon = state;
    b.reserved.delete(w.target);
    pump(b);
  };
  b.deps.startWorker(w.target, budget, onFinished).then(({ sessionID }) => {
    w.sessionID = sessionID;
    if (w.status === "starting") w.status = "running"; // it may have finished already
    if (b.stopping && w.status === "running") void b.deps.stopWorker(sessionID).catch(() => {});
  }).catch((e: unknown) => {
    w.status = "failed";
    w.reason = String((e as Error)?.message ?? e).slice(0, 300);
    b.reserved.delete(w.target);
    pump(b);
  });
}

function snapshot(b: Batch): ReconBatchState {
  for (const w of b.state.workers) {
    if (w.status === "running" && w.sessionID) w.recon = b.deps.workerState(w.sessionID) ?? w.recon;
  }
  if (b.state.status === "running") b.state.tokens = spent(b);
  return b.state;
}

/** Start a batch. One at a time: the workers share one agent, and its memory and CPU. */
export function startBatch(o: BatchStart): ReconBatchState {
  for (const b of batches.values()) if (b.state.status === "running") throw httpError(409, "A batch is already running. Stop it, or wait for it to finish.");
  const targets = parseTargets([...o.targets]);
  if (o.totalBudgetTokens !== undefined && o.totalBudgetTokens < MIN_WORKER_BUDGET) {
    throw httpError(400, `The batch's token budget must be at least ${MIN_WORKER_BUDGET}.`);
  }
  const state: ReconBatchState = {
    id: crypto.randomBytes(8).toString("hex"), status: "running", maxWorkers: resolveWorkers(o.maxWorkers),
    ...(o.totalBudgetTokens !== undefined ? { budgetTokens: o.totalBudgetTokens } : {}),
    tokens: 0, workers: targets.map((target) => ({ target, status: "queued" as const })), startedAt: Date.now(),
  };
  const b: Batch = { state, directory: o.directory, deps: o.deps, workerBudget: o.workerBudgetTokens, reserved: new Map(), stopping: false };
  batches.set(state.id, b);
  o.deps.log?.("recon.batch.started", { batch: state.id, targets: targets.length, maxWorkers: state.maxWorkers, budgetTokens: state.budgetTokens });
  pump(b);
  return snapshot(b);
}

/** A batch by id, or the most recent one when no id is given. */
export function batchState(id?: string): ReconBatchState | null {
  const b = id ? batches.get(id) : [...batches.values()].pop();
  return b ? snapshot(b) : null;
}

/** The project folder a batch's sessions live in. */
export function batchDirectory(id: string): string | undefined {
  return batches.get(id)?.directory;
}

/** Stop a batch: nothing queued is started, and every running worker is stopped. */
export async function stopBatch(id: string): Promise<ReconBatchState | null> {
  const b = batches.get(id);
  if (!b) return null;
  if (b.state.status === "running") {
    b.stopping = true;
    b.state.stopped = true;
    for (const w of b.state.workers) if (w.status === "queued") { w.status = "skipped"; w.reason = "the batch was stopped"; }
    await Promise.all(b.state.workers.filter((w) => w.status === "running" && w.sessionID).map((w) => b.deps.stopWorker(w.sessionID!).catch(() => {})));
    finishIfDone(b); // workers still starting are stopped as they come up, and end the batch then
  }
  return snapshot(b);
}

/** Forget finished batches (tests, and a tidy map). */
export function clearBatches(): void {
  for (const [id, b] of batches) if (b.state.status === "finished") batches.delete(id);
}
