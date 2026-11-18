/**
 * Supervised recon — the driver loop.
 * -----------------------------------------------------------------------------
 * Walks the recon roles from recon.ts into an actual run: seed the executor,
 * let it probe under the risk-tier gate, track budget/rounds, escalate on
 * evidence, and collect env-tagged findings — then stop cleanly.
 *
 * The loop's CONTROL LOGIC lives here and is pure + unit-tested against a fake
 * session runner. The one piece that must talk to OpenCode — actually running
 * an executor turn, streaming its events, auto-replying permissions the gate
 * clears, and parsing the verifier's findings — is the `ReconSessionRunner`
 * interface. The server implements it against the OpenCode SDK (the next
 * integration step); the loop never imports OpenCode, so it stays testable.
 *
 * Why the gate is wired through the runner rather than called between turns:
 * OpenCode streams `permission.asked` MID-turn and blocks until replied, so the
 * decision has to ride the event stream. The runner is handed `gate` and calls
 * it on each permission as it arrives.
 */

import {
  routeModel, harnessFor, classifyCommand, commandHazard, allCapped, originOf, escalateAfter,
  type ReconFinding, type EnvFidelity, type ReconHarness, type RouteSignals, type GateContext,
} from "./recon.js";

type Severity = ReconFinding["severity"];
const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const worstSeverity = (fs: readonly ReconFinding[]): Severity | undefined => {
  let best: Severity | undefined;
  for (const f of fs) if (f.verdict !== "rejected" && (!best || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best])) best = f.severity;
  return best;
};

/** Hard default caps so a run is NEVER unbounded, even with an empty harness. */
const DEFAULT_RECON_HARNESS: Required<Pick<ReconHarness, "maxRounds" | "budgetTokens">> = {
  maxRounds: 80,
  budgetTokens: 3_000_000,
};

/** A positive integer, or the fallback (defends against undefined/NaN/Infinity overrides). */
const posInt = (v: unknown, d: number): number => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : d);

/** Merge harness overrides over the profile and hard defaults WITHOUT letting an
 *  undefined/NaN/Infinity override erase a cap — the loop is never unbounded. */
function resolveHarness(override?: ReconHarness): ReconHarness {
  const merged = { ...DEFAULT_RECON_HARNESS, ...harnessFor("executor"), ...override };
  return {
    ...merged,
    maxRounds: posInt(merged.maxRounds, DEFAULT_RECON_HARNESS.maxRounds),
    budgetTokens: posInt(merged.budgetTokens, DEFAULT_RECON_HARNESS.budgetTokens),
  };
}

/** A pending tool permission, reduced to what the gate needs. */
export interface ReconPermission {
  /** OpenCode tool name: "bash", "edit", "write", "read", "webfetch", … */
  tool: string;
  /** The shell command, for bash/shell tools. */
  command?: string;
}

/**
 * The risk-tier gate: may the UI auto-allow this permission, or must a human
 * approve? Shell commands defer to `classifyCommand`; file-mutating and
 * network-reaching tools always ask; plain reads flow; the unknown fails closed.
 */
/** allow = auto-run; ask = pause for the human; deny = never run (hard-blocked). */
export type GateDecision = "allow" | "ask" | "deny";

export function reconGateDecision(p: ReconPermission, ctx: GateContext = {}): GateDecision {
  const tool = (p.tool ?? "").toLowerCase();
  if (!tool) return "ask"; // guard: a permission with no tool fails closed
  if (tool === "bash" || tool === "shell") {
    if (!p.command) return "ask";
    // Deny the handful of shapes that wreck the agent host or turn it into a
    // zombie (reverse shell, download->shell, exfil) — even a human shouldn't
    // one-click-approve those. These are NOT in-scope attacks on the target.
    if (commandHazard(p.command)) return "deny";
    return classifyCommand(p.command, ctx); // allow (tiny safe set) | ask (everything else)
  }
  if (tool === "read" || tool === "grep" || tool === "glob" || tool === "list" || tool === "ls") return "allow";
  // edit/write/patch/multiedit (mutate files), webfetch/fetch (reach out): always ask.
  return "ask";
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const get = (o: unknown, k: string): unknown => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined);

/**
 * Defensively pull a shell command out of a raw OpenCode permission object —
 * its shape varies by server version, so check the known spots and fail to
 * `undefined` (which the gate treats as "ask").
 */
export function extractReconCommand(raw: unknown): string | undefined {
  const toolInput = get(get(raw, "tool"), "input");
  // Only fields known to be the EXACT executed command. The `pattern` (a glob)
  // and a bare `input` string are deliberately NOT used: feeding the gate a
  // string other than what runs is a bypass (H1). Unknown shape -> undefined -> ask.
  return (
    str(get(raw, "command")) ??
    str(get(get(raw, "metadata"), "command")) ??
    str(get(get(raw, "input"), "command")) ??
    str(get(get(raw, "args"), "command")) ??
    str(get(toolInput, "command"))
  );
}

/** Mutable state of one recon run: spend, rounds, stuck-streak, findings. */
export class ReconRun {
  spentTokens = 0;
  rounds = 0;
  /** Consecutive turns the executor reported stuck — the escalation signal. */
  attempts = 0;
  readonly findings: ReconFinding[] = [];

  constructor(private readonly harness: ReconHarness = {}) {}

  recordUsage(tokens: number): void { if (tokens > 0) this.spentTokens += tokens; }
  recordRound(): void { this.rounds += 1; }
  recordStuck(): void { this.attempts += 1; }
  resetAttempts(): void { this.attempts = 0; }

  /** Keep every finding the verifier didn't reject. */
  addFindings(fs: readonly ReconFinding[]): void {
    for (const f of fs) if (f.verdict !== "rejected") this.findings.push(f);
  }

  /** Uncached input tokens left, or undefined when the harness sets no budget. */
  budgetRemaining(): number | undefined {
    return this.harness.budgetTokens === undefined ? undefined : Math.max(0, this.harness.budgetTokens - this.spentTokens);
  }
  outOfBudget(): boolean { const r = this.budgetRemaining(); return r !== undefined && r <= 0; }
  outOfRounds(): boolean { return this.harness.maxRounds !== undefined && this.rounds >= this.harness.maxRounds; }

  /** The worst severity seen so far, for the escalation signal. */
  highestSeverity(): Severity | undefined {
    let best: Severity | undefined;
    for (const f of this.findings) if (!best || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best]) best = f.severity;
    return best;
  }

  /** Signals for the router this round. severityHint is passed in per-turn by the
   *  driver (the CURRENT candidate's severity) — NOT accumulated, so one High
   *  finding does not pin every later turn to the frontier model (H2). */
  signals(extra: Pick<RouteSignals, "rateLimited" | "severityHint"> = {}): RouteSignals {
    return { attempts: this.attempts, budgetRemaining: this.budgetRemaining(), ...extra };
  }
}

/** One executor turn's outcome, as the session runner reports it. */
export interface ReconTurnResult {
  /** Uncached input tokens this turn (fed to the budget). */
  tokensUsed: number;
  /** Findings the verifier confirmed (or marked config-dependent) this turn. */
  findings: ReconFinding[];
  /** Did the turn advance the assessment (new facts/surface), or stall? */
  madeProgress: boolean;
  /** The executor reported it is stuck on the current thread. */
  stuck?: boolean;
  /** The executor reports the in-scope surface is exhausted — stop cleanly. */
  done?: boolean;
}

/** The OpenCode-facing seam. The server implements this; the loop stays pure. */
export interface ReconSessionRunner {
  /**
   * Run the executor once on `model` with `prompt`, applying `gate` to each
   * permission as it streams in. Resolves when the turn goes idle.
   */
  runTurn(args: { prompt: string; model: string; gate: (p: ReconPermission) => GateDecision }): Promise<ReconTurnResult>;
}

export interface ReconDriverOptions {
  objective: string;
  /** The single in-scope target, e.g. "http://quantum-local:8765" or a host. */
  scope: string;
  env: EnvFidelity;
  runner: ReconSessionRunner;
  /** Live provider/model health for the router (optional). */
  rateLimited?: () => Partial<Record<string, boolean>>;
  /** Override the run caps; defaults to the executor role's profile harness. */
  harness?: ReconHarness;
}

export interface ReconRunResult {
  findings: ReconFinding[];
  rounds: number;
  tokens: number;
  stopped: "done" | "idle" | "budget" | "rounds" | "stuck" | "rate-limited" | "error";
}

/** Build the executor's seed prompt: scope fence + env-fidelity gate + objective. */
export function buildReconKickoff(opts: Pick<ReconDriverOptions, "objective" | "scope" | "env">): string {
  const { objective, scope, env } = opts;
  const nonProd = env.nonProdSettings?.length ? ` Known non-production settings: ${env.nonProdSettings.join(", ")}.` : "";
  return [
    `SCOPE (authorisation fence): test only ${scope}. Anything outside it is out of bounds — do not touch it.`,
    `ENVIRONMENT FIDELITY: this is a ${env.kind} instance. ${env.divergences}${nonProd} Tag every finding with this environment; if a finding depends on a setting that differs from production, mark it config-dependent and say what to re-test against production — never report it as a clean production bug.`,
    `OBJECTIVE: ${objective}`,
    `Work one hypothesis at a time with the smallest low-impact probe. Read-only probes run freely; anything that changes state pauses for human approval. When you have a candidate, hand it to the recon-verify subagent — do not promote it yourself.`,
  ].join("\n\n");
}

/** Prompt that nudges the executor forward after a turn goes idle with work left. */
export const RECON_CONTINUE =
  "Continue: take the next untested hypothesis within scope. If the in-scope surface is genuinely exhausted, stop and say so rather than widening scope. Hand any new candidate to recon-verify.";

/**
 * Drive one supervised recon run to completion. Pure control flow over the
 * injected runner: route (and escalate) the executor model each round, run a
 * turn under the gate, fold in usage and findings, and stop on done / idle /
 * budget / rounds. The harness for the executor role supplies the caps.
 */
export async function driveRecon(opts: ReconDriverOptions): Promise<ReconRunResult> {
  const run = new ReconRun(resolveHarness(opts.harness));
  const { host: scopeHost, port: scopePort } = originOf(opts.scope);
  const gate = (p: ReconPermission) => reconGateDecision(p, { scopeHost, scopePort });
  const maxStuck = escalateAfter() + 2; // give escalation a chance before giving up
  let prompt = buildReconKickoff(opts);
  // One-shot: the worst severity found LAST turn informs THIS turn's routing, then clears.
  let severityHint: Severity | undefined;

  for (;;) {
    const signals = run.signals({ rateLimited: opts.rateLimited?.(), severityHint });
    // Every model is rate-limited — back off rather than thrash (H4).
    if (allCapped(signals)) return finish(run, "rate-limited");

    const model = routeModel("executor", signals);
    let res: ReconTurnResult;
    try {
      res = await opts.runner.runTurn({ prompt, model, gate });
    } catch {
      return finish(run, "error"); // keep the findings gathered so far (M2)
    }

    run.recordRound();
    run.recordUsage(res.tokensUsed);
    run.addFindings(res.findings);
    severityHint = worstSeverity(res.findings);
    if (res.stuck) run.recordStuck(); else run.resetAttempts();

    if (res.done) return finish(run, "done");                       // a clean finish wins over the caps
    if (run.outOfBudget()) return finish(run, "budget");
    if (run.outOfRounds()) return finish(run, "rounds");
    if (run.attempts >= maxStuck) return finish(run, "stuck");      // persistently stuck, even escalated (H3)
    if (!res.madeProgress && !res.stuck) return finish(run, "idle"); // surface spent

    prompt = RECON_CONTINUE;
  }
}

function finish(run: ReconRun, stopped: ReconRunResult["stopped"]): ReconRunResult {
  return { findings: run.findings, rounds: run.rounds, tokens: run.spentTokens, stopped };
}
