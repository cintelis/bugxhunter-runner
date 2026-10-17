// Starts a governed run on the runner, with nobody at the keyboard: a session
// in the engagement's folder, and the prompt. What a webhook will do when a
// pull request opens; for now, a command.
//
//   node sigilant/run.ts --pr cintelis/sigilant#42
//   node sigilant/run.ts --prompt "Test what the last deploy changed on erp:9443."
//   node sigilant/run.ts --discover                    # the scope in BXH_SCOPE_REPOS and BXH_SCOPE_TARGETS
//   node sigilant/run.ts --deploy erp:9443 --version 1.4.2 --changed /api/orders,/api/invoices   # a deploy to retest
//
// | Variable | |
// |---|---|
// | `BXH_RUNNER` | the runner's API: `http://bxh-runner:8790` unless set |
// | `BXH_DIRECTORY` | the engagement's folder in the workspace: `/workspace/engagement` unless set |
// | `BXH_MODEL` | the model, as OpenCode names it; the runner's default unless set |
// | `BXH_SCOPE_REPOS`, `BXH_SCOPE_TARGETS` | what a discovery run looks through, comma-separated: the scope, as the policy's entities have it |
// | the identity's, see identity.ts | to report each step's usage through the gateway; without them the run is started and left |
//
// `--no-follow` starts the run and returns at once, reporting nothing.

import { mkdir } from "node:fs/promises";

import type { SigilantClient } from "@sigilant/sdk";

import { identityConfigured, sigilantClient } from "./identity.ts";
import { type StepUsage, describeStep, followRun } from "./usage.ts";

export interface Run {
  directory: string;
  text: string;
  agent?: string;
  model?: string;
}

/** The prompt a pull request opening starts. */
export function reviewPrompt(repo: string, pr: number): string {
  return [
    `Review pull request #${pr} of ${repo} for security issues, as a governed run.`,
    `Read its diff with repo.read (repo "${repo}", pr ${pr}), and the files it touches where you need the context; read what GitHub's own scanners hold open with repo.alerts (repo "${repo}"), and use it rather than rediscover it.`,
    `Record each finding with finding.record at a severity, with where "${repo}" and, as detail, the file and the line; then comment on the pull request with repo.comment: one summary, findings first, each with the file and what to change.`,
    "If a finding is critical, block the merge with repo.block and say that a tester confirms it.",
    "Do nothing outside this pull request.",
  ].join(" ");
}

/** What a deploy says of itself: the target, and what it changed, as far as it says. */
export interface Deploy {
  /** `host:port`, as the scope names it. */
  target: string;
  version?: string;
  /** Paths the deploy changed, where it says; empty, the whole target is retested. */
  changed?: string[];
  note?: string;
}

/** The prompt a deploy of a target starts: retest what it changed, and nothing it did not. */
export function deployPrompt(deploy: Deploy): string {
  const where = `${deploy.target}${deploy.version ? ` at version ${deploy.version}` : ""}`;
  const changed = deploy.changed?.length
    ? `It changed: ${deploy.changed.join(", ")}. Retest those paths first, then what depends on them.`
    : "It did not say what changed: retest the target as a whole, starting from /, /health and /mcp and what they lead to.";
  return [
    `A deploy of ${where} has just happened; retest it, as a governed run.`,
    changed,
    `Use target.request (target "${deploy.target}"): GET each path and check that it still answers as it should, that it still requires authentication where it did, and that nothing is disclosed that was not before.`,
    "A request that could change state needs a person's approval; make one only where the test needs it, and carry on with the rest while it waits.",
    `Record with finding.record only what is wrong — something disclosed, a check that can be skipped, an answer that should not be — at a severity, with where "${deploy.target}" and, as detail, the request and what it answered. What still holds as it should is not a finding: it goes in the summary.`,
    deploy.note ? `The deploy's note: ${deploy.note}` : "",
    "End with a short summary: what was retested, what changed in its behaviour since before the deploy as far as you can tell, and what was recorded.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The prompt a discovery run starts with: the scope, as the engagement has it. */
export function discoverPrompt(repos: string[], targets: string[]): string {
  return [
    "Run a discovery of agents and MCP servers inside the engagement's scope, as a governed run.",
    repos.length ? `Repositories to scan with repo.scan: ${repos.join(", ")}.` : "There are no repositories in scope.",
    targets.length ? `Targets to ask with net.discover: ${targets.join(", ")}.` : "There are no targets in scope.",
    "Report each thing found with discovery.report, naming where exactly as given here, and nothing outside the scope.",
    "End with a short summary of what was found and reported.",
  ].join(" ");
}

/** Starts the run: the session, then the prompt. Returns the session's id. */
export async function startRun(runner: string, run: Run, fetchImpl: typeof fetch = fetch): Promise<string> {
  const post = async (path: string, body: unknown) => {
    const response = await fetchImpl(`${runner}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as Record<string, unknown>;
  };
  const session = await post("/api/agent/session", { directory: run.directory });
  const sessionID = String(session.id);
  await post("/api/agent/prompt", {
    sessionID,
    directory: run.directory,
    text: run.text,
    agent: run.agent ?? "build",
    ...(run.model ? { model: run.model } : {}),
  });
  return sessionID;
}

/**
 * Reports one step's usage through the gateway as `run.usage`, under the
 * runner's identity: allowed, it is a signed record of the chain. A gateway
 * that will not take it is said, and the run goes on: usage is the runner's
 * word on itself, and nothing waits on it.
 */
export function usageReporter(client: Pick<SigilantClient, "callUntilDecided">, log: (line: string) => void): (step: StepUsage) => Promise<void> {
  return async (step) => {
    try {
      const outcome = await client.callUntilDecided("run.usage", { ...step }, { everySecs: 15, signal: AbortSignal.timeout(60_000) });
      if (outcome.status === "done" && !outcome.isError) log(`reported ${describeStep(step)}`);
      else log(`the gateway did not take ${step.step}'s usage: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
    } catch (why) {
      log(`reporting ${step.step}'s usage failed: ${(why as Error).message}`);
    }
  };
}

/** `owner/name#number`, or nothing. */
export function parsePr(s: string): { repo: string; pr: number } | undefined {
  const m = /^([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+)#(\d{1,9})$/.exec(s.trim());
  return m ? { repo: m[1]!, pr: Number(m[2]) } : undefined;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const pr = at("--pr");
  const prompt = at("--prompt");
  const discover = args.includes("--discover");
  const deploy = at("--deploy");
  const parsed = pr ? parsePr(pr) : undefined;
  if ((pr && !parsed) || (!parsed && !prompt && !discover && !deploy)) {
    console.error("usage: node sigilant/run.ts --pr owner/name#number | --prompt <text> | --discover | --deploy host:port [--version v] [--changed /a,/b] [--note …]");
    process.exit(2);
  }
  const split = (value: string | undefined) => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const list = (name: string) => split(process.env[name]);
  const text = parsed
    ? reviewPrompt(parsed.repo, parsed.pr)
    : discover
      ? discoverPrompt(list("BXH_SCOPE_REPOS"), list("BXH_SCOPE_TARGETS"))
      : deploy
        ? deployPrompt({ target: deploy, version: at("--version"), changed: split(at("--changed")), note: at("--note") })
        : prompt!;
  const runner = process.env.BXH_RUNNER?.trim() || "http://bxh-runner:8790";
  const directory = process.env.BXH_DIRECTORY?.trim() || "/workspace/engagement";
  // The engagement's folder in the shared workspace, which the runner expects to find.
  await mkdir(directory, { recursive: true });
  const id = await startRun(runner, { directory, text, model: process.env.BXH_MODEL?.trim() || undefined });
  console.log(`started session ${id} in ${directory} on ${runner}`);
  if (args.includes("--no-follow")) process.exit(0);
  const log = (line: string) => console.log(`${new Date().toISOString()} [run] ${line}`);
  if (!identityConfigured()) {
    log("no Sigilant identity is configured (SIGILANT_ISSUER, SIGILANT_GATEWAY): the run is left to itself, its usage unreported");
    process.exit(0);
  }
  const client = await sigilantClient({ name: "bugxhunter-run", version: "0.1.0" });
  const steps = await followRun(runner, id, directory, usageReporter(client, log), { log });
  const cost = steps.reduce((sum, s) => sum + s.cost_micros, 0) / 1_000_000;
  log(`${id} is idle: ${steps.length} step${steps.length === 1 ? "" : "s"} reported, $${cost.toFixed(4)} in all`);
}
