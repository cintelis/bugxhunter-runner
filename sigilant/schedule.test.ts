import { strict as assert } from "node:assert";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Run } from "./run.ts";
import {
  dueAt,
  jobsOf,
  parseEvery,
  readState,
  retestPrompt,
  sayEvery,
  schedule,
  writeState,
} from "./schedule.ts";

const DAY = 86_400_000;

test("an interval is minutes, hours or days, or never, and is said back", () => {
  assert.equal(parseEvery("24h"), DAY);
  assert.equal(parseEvery("7d"), 7 * DAY);
  assert.equal(parseEvery(" 90M "), 90 * 60_000);
  assert.equal(parseEvery("0"), 0);
  assert.equal(parseEvery("off"), 0);
  assert.equal(parseEvery(undefined), 0);
  assert.throws(() => parseEvery("soon"), /not an interval/);
  assert.equal(sayEvery(DAY), "1 d");
  assert.equal(sayEvery(36 * 3_600_000), "36 h");
  assert.equal(sayEvery(90 * 60_000), "90 min");
});

test("the timetable's jobs are a retest of each target and a discovery of the scope, each off where there is nothing for it", () => {
  const jobs = jobsOf({
    root: "/w",
    targets: ["erp:9443", "fleet-tools:9443"],
    repos: ["cintelis/sigilant"],
    retestEvery: DAY,
    discoverEvery: 7 * DAY,
  });
  assert.deepEqual(
    jobs.map((j) => [j.name, j.every]),
    [
      ["retest", DAY],
      ["discover", 7 * DAY],
    ],
  );
  const at = Date.UTC(2026, 9, 18, 9, 0, 0);
  const retests = jobs[0]!.runs(at, at - DAY);
  assert.deepEqual(
    retests.map((r) => r.directory),
    [
      "/w/targets/erp-9443/retest-20261018T090000Z",
      "/w/targets/fleet-tools-9443/retest-20261018T090000Z",
    ],
  );
  assert.deepEqual(
    retests.map((r) => r.title),
    ["Scheduled retest of erp:9443", "Scheduled retest of fleet-tools:9443"],
    "each run named for what it is",
  );
  assert.equal(jobs[1]!.runs(at, undefined)[0]!.title, "Scheduled discovery of the scope");
  assert.match(
    retests[0]!.text,
    /A scheduled retest of erp:9443, 1 d after the last, at 2026-10-17T09:00:00.000Z/,
  );
  assert.match(retests[1]!.text, /with where "fleet-tools:9443"/);
  assert.match(
    jobs[1]!.runs(at, undefined)[0]!.text,
    /Repositories to scan with repo.scan: cintelis\/sigilant\./,
  );
  assert.equal(
    jobs[1]!.runs(at, undefined)[0]!.directory,
    "/w/discovery/20261018T090000Z",
  );
  assert.match(
    retestPrompt("erp:9443", DAY, undefined),
    /the first of its kind/,
  );
  const none = jobsOf({
    root: "/w",
    targets: [],
    repos: [],
    retestEvery: DAY,
    discoverEvery: 7 * DAY,
  });
  assert.deepEqual(
    none.map((j) => j.every),
    [0, 0],
    "nothing in scope, nothing to run",
  );
});

test("a job is due at once when it never ran, when its interval has passed since it did, and after a grace either way", () => {
  const job = jobsOf({
    root: "/w",
    targets: ["erp:9443"],
    repos: [],
    retestEvery: DAY,
    discoverEvery: 0,
  })[0]!;
  const started = 1_000_000;
  assert.equal(
    dueAt(job, { last: {} }, started, 120_000),
    started + 120_000,
    "never ran: after the grace",
  );
  assert.equal(
    dueAt(job, { last: { retest: started - DAY - 5 } }, started, 120_000),
    started + 120_000,
    "overdue: after the grace, not at once",
  );
  assert.equal(
    dueAt(job, { last: { retest: started - 1_000 } }, started, 120_000),
    started - 1_000 + DAY,
    "ran lately: when its interval is up",
  );
  assert.equal(
    dueAt({ ...job, every: 0 }, { last: {} }, started, 0),
    undefined,
    "off: never",
  );
});

test("the timetable is kept: due jobs run one after another, are written down first, and survive a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bxh-schedule-"));
  const file = join(dir, "schedule.json");
  let clock = Date.UTC(2026, 9, 18, 9, 0, 0);
  const ran: { why: string; dir: string; at: number }[] = [];
  const lines: string[] = [];
  const jobs = jobsOf({
    root: "/w",
    targets: ["erp:9443", "fleet-tools:9443"],
    repos: ["cintelis/sigilant"],
    retestEvery: DAY,
    discoverEvery: 7 * DAY,
  });
  const kept = schedule({
    jobs,
    stateFile: file,
    now: () => clock,
    tickMs: 1_000_000,
    graceMs: 0,
    log: (l) => lines.push(l),
    run: async (run: Run, why) => {
      ran.push({ why, dir: run.directory, at: clock });
      clock += 60_000; // each run takes a minute
    },
  });
  let again: { stop(): void; tick(): Promise<void> } | undefined;
  try {
    await kept.tick();
    assert.deepEqual(
      ran.map((r) => r.why),
      ["retest", "retest", "discover"],
      "both due at once, having never run: every target's retest, then the discovery, one after another",
    );
    const written = JSON.parse(await readFile(file, "utf8")) as {
      last: Record<string, number>;
    };
    assert.equal(
      written.last.retest,
      Date.UTC(2026, 9, 18, 9, 0, 0),
      "written down when it began",
    );
    assert.ok(lines.some((l) => /retest is due \(never ran\): 2 runs/.test(l)));

    // An hour on: nothing is due.
    clock += 3_600_000;
    await kept.tick();
    assert.equal(ran.length, 3);
    // A day on: the retest is due again; the discovery is not.
    clock = Date.UTC(2026, 9, 19, 9, 5, 0);
    await kept.tick();
    assert.deepEqual(
      ran.slice(3).map((r) => r.why),
      ["retest", "retest"],
    );
    kept.stop();

    // Restarted the next morning: the file says when each ran, so only what is due runs.
    again = schedule({
      jobs,
      stateFile: file,
      now: () => clock,
      tickMs: 1_000_000,
      graceMs: 0,
      run: async (run, why) =>
        void ran.push({ why, dir: run.directory, at: clock }),
    });
    await again.tick();
    assert.equal(ran.length, 5, "nothing due a moment after the retest ran");
    clock += DAY;
    await again.tick();
    assert.equal(
      ran.length,
      7,
      "the next day's retest, and still no discovery",
    );
  } finally {
    kept.stop();
    again?.stop();
  }

  // A state file that is not one is as if there were none.
  await writeState(file, { last: { retest: Number.NaN } });
  assert.deepEqual(await readState(file), { last: {} });
  assert.deepEqual(await readState(join(dir, "missing.json")), { last: {} });
});
