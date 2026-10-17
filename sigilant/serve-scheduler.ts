// The timetable (schedule.ts) as a process: a retest of each target every so
// often, a discovery of the scope less often, each run followed and its
// usage reported under the runner's identity.
//
//   node sigilant/serve-scheduler.ts                 # keeps the timetable
//   node sigilant/serve-scheduler.ts --now retest    # one retest of every target, now, and exit
//   node sigilant/serve-scheduler.ts --now discover  # one discovery, now, and exit
//
// | Variable | |
// |---|---|
// | `SCHEDULE_RETEST_EVERY` | how often each target is retested: `24h` unless set; `0` never |
// | `SCHEDULE_DISCOVER_EVERY` | how often the scope is discovered: `7d` unless set; `0` never |
// | `SCHEDULE_STATE_FILE` | where the timetable remembers itself: `<BXH_DIRECTORY>/schedule.json` unless set |
// | `BXH_SCOPE_TARGETS`, `BXH_SCOPE_REPOS` | the scope, comma-separated, as the policy's entities have it |
// | `BXH_RUNNER` | the runner's API: `http://bxh-runner:8790` unless set |
// | `BXH_DIRECTORY` | where each run's folder goes: `/workspace/engagement` unless set |
// | `BXH_MODEL` | the model, as OpenCode names it; the runner's default unless set |
// | the identity's, see identity.ts | to report each step's usage; without them runs are started and followed, their usage unreported |

import { mkdir } from "node:fs/promises";

import { env, identityConfigured, sigilantClient } from "./identity.ts";
import { type Run, startRun, usageReporter } from "./run.ts";
import { jobsOf, parseEvery, schedule } from "./schedule.ts";
import { followRun } from "./usage.ts";

const log = (line: string) => console.log(`${new Date().toISOString()} [scheduler] ${line}`);
const split = (value: string | undefined) => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const runner = env("BXH_RUNNER", "http://bxh-runner:8790");
const root = env("BXH_DIRECTORY", "/workspace/engagement");
const model = process.env.BXH_MODEL?.trim() || undefined;
const targets = split(process.env.BXH_SCOPE_TARGETS);
const repos = split(process.env.BXH_SCOPE_REPOS);
const retestEvery = parseEvery(process.env.SCHEDULE_RETEST_EVERY ?? "24h");
const discoverEvery = parseEvery(process.env.SCHEDULE_DISCOVER_EVERY ?? "7d");

const report = identityConfigured() ? usageReporter(await sigilantClient({ name: "bugxhunter-scheduler", version: "0.1.0" }), log) : undefined;
if (!report) log("no Sigilant identity is configured (SIGILANT_ISSUER, SIGILANT_GATEWAY): runs are followed, their usage unreported");

/** Starts a run and follows it until the runner is idle, so that the next waits its turn. */
async function run(what: Run, why: string): Promise<void> {
  await mkdir(what.directory, { recursive: true });
  const id = await startRun(runner, { ...what, model });
  log(`${why}: started ${id} in ${what.directory}`);
  const steps = await followRun(runner, id, what.directory, report ?? (async () => {}), { log });
  log(`${why}: ${id} is idle, ${steps.length} step${steps.length === 1 ? "" : "s"}`);
}

const jobs = jobsOf({ root, targets, repos, retestEvery, discoverEvery });
const args = process.argv.slice(2);
const at = args.indexOf("--now");
if (at >= 0) {
  const name = args[at + 1];
  const job = jobs.find((j) => j.name === name);
  if (!job) {
    console.error("usage: node sigilant/serve-scheduler.ts [--now retest|discover]");
    process.exit(2);
  }
  for (const what of job.runs(Date.now(), undefined)) await run(what, `${name}, by hand`);
  process.exit(0);
}

const kept = schedule({ jobs, stateFile: process.env.SCHEDULE_STATE_FILE?.trim() || `${root}/schedule.json`, run, log });
log(`keeping the timetable for ${targets.join(", ") || "no target"} and ${repos.join(", ") || "no repository"}, starting runs on ${runner}`);
void kept.tick();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    kept.stop();
    process.exit(0);
  });
}
