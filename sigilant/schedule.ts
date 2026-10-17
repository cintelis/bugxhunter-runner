// Runs on a timetable, with nobody at the keyboard: a retest of each target
// every so often — is it still secure a day later? — and a discovery of the
// scope less often. Each job remembers when it last ran, in a file in the
// workspace, so that a restart neither forgets nor starts everything again;
// one overdue when the scheduler starts runs after a short grace, so that a
// platform that has just restarted has its keys in place first.
//
// Runs of one job go one after another — each is followed until the runner
// is idle, and its usage reported — so that a timetable never piles sessions
// onto the runner.

import { readFile, writeFile } from "node:fs/promises";

import { type Run, discoverPrompt } from "./run.ts";

/** `0`/`off`, or a number of minutes (`90m`), hours (`24h`) or days (`7d`), in ms. */
export function parseEvery(text: string | undefined): number {
  const value = (text ?? "").trim().toLowerCase();
  if (value === "" || value === "0" || value === "off" || value === "never") return 0;
  const m = /^(\d+)\s*(m|h|d)$/.exec(value);
  if (!m) throw new Error(`not an interval: "${text}" (90m, 24h, 7d, or 0)`);
  const n = Number(m[1]);
  return n * (m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000);
}

/** An interval, said: `24 h`, `7 d`, `90 min`. */
export function sayEvery(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  return `${Math.round(ms / 60_000)} min`;
}

/** What each job last did, as the file keeps it. */
export interface State {
  /** When each job last ran, Unix ms, by job name. */
  last: Record<string, number>;
}

export async function readState(file: string): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<State>;
    const last = typeof parsed.last === "object" && parsed.last !== null ? parsed.last : {};
    return { last: Object.fromEntries(Object.entries(last).filter(([, v]) => typeof v === "number" && Number.isFinite(v))) as Record<string, number> };
  } catch {
    return { last: {} };
  }
}

export async function writeState(file: string, state: State): Promise<void> {
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** One job of the timetable. */
export interface Job {
  name: string;
  /** How often, in ms; `0` is never. */
  every: number;
  /** The runs it starts, in order; each is followed before the next. */
  runs(now: number, lastAt: number | undefined): Run[];
}

/** The prompt a scheduled retest of a target starts: nothing is known to have changed. */
export function retestPrompt(target: string, every: number, lastAt: number | undefined): string {
  const since = lastAt ? `${sayEvery(every)} after the last, at ${new Date(lastAt).toISOString()}` : "the first of its kind";
  return [
    `A scheduled retest of ${target}, ${since}: nothing is known to have changed, and the question is whether it is still as it was.`,
    "Retest the target as a whole with target.request: GET /, /health and /mcp and what they lead to, and check that each still answers as it should, still requires authentication where it did, and discloses nothing new.",
    "A request that could change state needs a person's approval; make one only where the test needs it, and carry on with the rest while it waits.",
    `Record with finding.record only what is wrong — something disclosed, a check that can be skipped, an answer that should not be — at a severity, with where "${target}" and, as detail, the request and what it answered. What still holds as it should is not a finding: it goes in the summary.`,
    "End with a short summary: what was retested, what has changed since the last retest as far as you can tell, and what was recorded.",
  ].join(" ");
}

/** A folder's worth of a name: what is not plain is a dash. */
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "unnamed";
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** The jobs an engagement's timetable holds, for its scope. */
export function jobsOf(options: { root: string; targets: string[]; repos: string[]; retestEvery: number; discoverEvery: number }): Job[] {
  const { root, targets, repos } = options;
  return [
    {
      name: "retest",
      every: targets.length ? options.retestEvery : 0,
      runs: (now, lastAt) =>
        targets.map((target) => ({
          directory: `${root}/targets/${slug(target)}/retest-${stamp(now)}`,
          text: retestPrompt(target, options.retestEvery, lastAt),
          title: `Scheduled retest of ${target}`,
        })),
    },
    {
      name: "discover",
      every: targets.length + repos.length ? options.discoverEvery : 0,
      runs: (now) => [{ directory: `${root}/discovery/${stamp(now)}`, text: discoverPrompt(repos, targets), title: "Scheduled discovery of the scope" }],
    },
  ];
}

/** When `job` is next due, given when it last ran: at once if never, or overdue. */
export function dueAt(job: Job, state: State, startedAt: number, grace: number): number | undefined {
  if (job.every <= 0) return undefined;
  const last = state.last[job.name];
  if (last === undefined) return startedAt + grace;
  return Math.max(last + job.every, startedAt + grace);
}

export interface SchedulerOptions {
  jobs: Job[];
  stateFile: string;
  /** Starts a run and follows it until the runner is idle. */
  run(run: Run, why: string): Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
  /** How often the timetable is looked at: a minute unless set. */
  tickMs?: number;
  /** How long after starting before an overdue job runs: two minutes unless set. */
  graceMs?: number;
}

/**
 * The timetable, kept: looks at each job every tick, runs the ones due — one
 * run after another — and writes down when. The first look is the caller's
 * to ask for (`tick`); a tick while one is under way does nothing.
 */
export function schedule(options: SchedulerOptions): { stop(): void; tick(): Promise<void> } {
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const startedAt = now();
  const grace = options.graceMs ?? 2 * 60_000;
  let state: State | undefined;
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      state ??= await readState(options.stateFile);
      for (const job of options.jobs) {
        const due = dueAt(job, state, startedAt, grace);
        const at = now();
        if (due === undefined || at < due) continue;
        const lastAt = state.last[job.name];
        const runs = job.runs(at, lastAt);
        log(`${job.name} is due (${lastAt ? `last ran ${new Date(lastAt).toISOString()}` : "never ran"}): ${runs.length} run${runs.length === 1 ? "" : "s"}`);
        // Written down before the runs, so that a crash mid-way does not start them all again.
        state.last[job.name] = at;
        await writeState(options.stateFile, state).catch((why: Error) => log(`could not write ${options.stateFile}: ${why.message}`));
        for (const run of runs) {
          if (stopped) return;
          try {
            await options.run(run, job.name);
          } catch (why) {
            log(`${job.name}: a run failed: ${(why as Error).message}`);
          }
        }
      }
    } finally {
      running = false;
    }
  };

  for (const job of options.jobs) log(job.every > 0 ? `${job.name}: every ${sayEvery(job.every)}` : `${job.name}: off`);
  const timer = setInterval(() => void tick(), options.tickMs ?? 60_000);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
}

/** For the command line: the retest of one target, as the timetable would start it. */
export function oneRetest(root: string, target: string, every: number, now = Date.now()): Run {
  return { directory: `${root}/targets/${slug(target)}/retest-${stamp(now)}`, text: retestPrompt(target, every, undefined), title: `Retest of ${target}` };
}
