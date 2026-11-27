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
  routeModel, harnessFor, classifyCommand, commandHazard, allCapped, originOf, escalateAfter, STATUS_LINE,
  type ReconFinding, type ReconChain, type ReconChainStep, type ChainCandidate,
  type EnvFidelity, type ReconHarness, type RouteSignals, type GateContext,
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
export function resolveHarness(override?: ReconHarness): ReconHarness {
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
  /** Attack paths from the chain pass: demonstrated ones and partial leads. */
  readonly chains: ReconChain[] = [];

  constructor(private readonly harness: ReconHarness = {}) {}

  recordUsage(tokens: number): void { if (tokens > 0) this.spentTokens += tokens; }
  recordRound(): void { this.rounds += 1; }
  recordStuck(): void { this.attempts += 1; }
  resetAttempts(): void { this.attempts = 0; }

  /**
   * Keep every finding the verifier didn't reject, and number it (F1, F2, …) so an attack
   * path can name it. The id is set on the finding itself: the run's live view holds the
   * same object.
   */
  addFindings(fs: readonly ReconFinding[]): void {
    for (const f of fs) {
      if (f.verdict === "rejected") continue;
      f.id = `F${this.findings.length + 1}`;
      this.findings.push(f);
    }
  }

  /** Keep the attack paths the verifier looked at, numbered P1, P2, …. */
  addChains(cs: readonly ReconChain[]): void {
    for (const c of cs) {
      c.id = `P${this.chains.length + 1}`;
      this.chains.push(c);
    }
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
  /** Attack paths from the chain pass (none until the pass runs). */
  chains: ReconChain[];
  rounds: number;
  tokens: number;
  stopped: "done" | "idle" | "budget" | "rounds" | "stuck" | "rate-limited" | "error";
}

const STATUS_REMINDER = `End your turn with one final line: "${STATUS_LINE}: continue", "${STATUS_LINE}: stuck" or "${STATUS_LINE}: done".`;

/** Build the executor's seed prompt: scope fence + env-fidelity gate + objective. */
export function buildReconKickoff(opts: Pick<ReconDriverOptions, "objective" | "scope" | "env">): string {
  const { objective, scope, env } = opts;
  const nonProd = env.nonProdSettings?.length ? ` Known non-production settings: ${env.nonProdSettings.join(", ")}.` : "";
  return [
    `SCOPE (authorisation fence): test only ${scope}. Anything outside it is out of bounds — do not touch it.`,
    `ENVIRONMENT FIDELITY: this is a ${env.kind} instance. ${env.divergences}${nonProd} Tag every finding with this environment; if a finding depends on a setting that differs from production, mark it config-dependent and say what to re-test against production — never report it as a clean production bug.`,
    `OBJECTIVE: ${objective}`,
    `Work one hypothesis at a time with the smallest low-impact probe. Read-only probes run freely; anything that changes state pauses for human approval. When you have a candidate, hand it to the recon-verify subagent — do not promote it yourself.`,
    STATUS_REMINDER,
  ].join("\n\n");
}

/** Prompt that nudges the executor forward after a turn goes idle with work left. */
export const RECON_CONTINUE =
  "Continue: take the next untested hypothesis within scope. If the in-scope surface is genuinely exhausted, stop and say so rather than widening scope. Hand any new candidate to recon-verify. " + STATUS_REMINDER;

/* ─────────────── reading a turn back (pure; the session runner calls these) ─────────────── */

/**
 * What the executor said about its own turn, from its final `RECON-STATUS:` line
 * (the last one wins). Without the line, a turn that completed at least one tool
 * call is taken to have made progress, and one that did nothing is idle.
 */
export function parseTurnStatus(text: string, toolsCompleted: number): Pick<ReconTurnResult, "madeProgress" | "stuck" | "done"> {
  const all = [...text.matchAll(new RegExp(`${STATUS_LINE}:\\s*\\**\\s*(continue|stuck|done)\\b`, "gi"))];
  const status = all.length ? all[all.length - 1][1].toLowerCase() : undefined;
  if (status === "done") return { madeProgress: true, done: true };
  if (status === "stuck") return { madeProgress: false, stuck: true };
  if (status === "continue") return { madeProgress: true };
  return { madeProgress: toolsCompleted > 0 };
}

const VERDICTS: readonly ReconFinding["verdict"][] = ["real", "config-dependent", "rejected"];
const SEVERITIES: readonly Severity[] = ["low", "medium", "high", "critical"];
const clipText = (v: unknown, n: number): string | undefined => {
  const s = str(v)?.trim();
  return s ? (s.length > n ? s.slice(0, n) + "…" : s) : undefined;
};

/** Every top-level `{…}` span in `text` (string-aware brace matching). */
function jsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { if (depth) inStr = true; continue; }
    if (c === "{") { if (depth++ === 0) start = i; }
    else if (c === "}" && depth && --depth === 0) out.push(text.slice(start, i + 1));
  }
  return out;
}

/**
 * The verifier's verdicts, parsed from its reply (the JSON block its prompt asks
 * for). Anything that is not valid JSON with a known verdict AND severity is
 * dropped: an unparseable verdict is never promoted to a finding. The text is
 * model output about an adversarial target, so it is clipped and stays data.
 */
export function parseVerifierFindings(text: string, env: EnvFidelity["kind"]): ReconFinding[] {
  const out: ReconFinding[] = [];
  for (const raw of jsonObjects(text ?? "")) {
    let o: unknown;
    try { o = JSON.parse(raw); } catch { continue; }
    if (isChainVerdict(o)) continue; // an attack path is not a finding: parseVerifierChains reads it
    const verdict = VERDICTS.find((v) => v === String(get(o, "verdict")).toLowerCase());
    const severity = SEVERITIES.find((s) => s === String(get(o, "severity")).toLowerCase());
    const repro = clipText(get(o, "repro"), 4000);
    if (!verdict || !severity || !repro) continue;
    out.push({
      title: clipText(get(o, "title"), 200) ?? repro.slice(0, 80),
      severity, verdict, repro, env,
      standardId: clipText(get(o, "standard_id") ?? get(o, "standardId"), 60),
      prodCaveat: clipText(get(o, "prod_caveat") ?? get(o, "prodCaveat"), 1000),
    });
  }
  return out;
}

/* ─────────────── attack paths (the chain pass reads these; pure) ─────────────── */

const MAX_CHAIN_STEPS = 8;

/** The verifier marks a path's verdict `"kind": "chain"`; one that lists the findings it links counts too. */
function isChainVerdict(o: unknown): boolean {
  return String(get(o, "kind")).toLowerCase() === "chain" || Array.isArray(get(o, "links"));
}

/** "F2" from "F2", "f2", " 2 " or 2; undefined for anything else. */
function findingId(v: unknown): string | undefined {
  const m = /^\s*f?\s*(\d{1,4})\s*$/i.exec(typeof v === "number" ? String(v) : typeof v === "string" ? v : "");
  return m ? `F${Number(m[1])}` : undefined;
}

/** The ids in `raw` that name a finding of this run, each once, in the order given. Unknown ones are dropped. */
function knownLinks(raw: unknown, findings: readonly ReconFinding[]): string[] {
  const known = new Set(findings.map((f) => f.id).filter((id): id is string => Boolean(id)));
  const out: string[] = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    const id = findingId(v);
    if (id && known.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** A step given as text, or as an object with its action and evidence. */
function chainStep(v: unknown): ReconChainStep | undefined {
  const action = clipText(typeof v === "string" ? v : get(v, "action") ?? get(v, "step") ?? get(v, "what"), 600);
  if (!action) return undefined;
  const evidence = typeof v === "string" ? undefined : clipText(get(v, "evidence") ?? get(v, "repro"), 2000);
  return evidence ? { action, evidence } : { action };
}

/**
 * The paths the proposer suggested, from its reply: `{"paths": [...]}` or the path objects
 * on their own. A path is kept only if it has two or more steps and builds on at least one
 * finding of this run; ids that name no finding are dropped. At most `max` are returned, in
 * the order given (the proposer ranks them). Like every model reply here, the text stays
 * data: it is clipped, and nothing in it is acted on except through the gate.
 */
export function parseChainProposal(text: string, findings: readonly ReconFinding[], max: number): ChainCandidate[] {
  const out: ChainCandidate[] = [];
  const take = (o: unknown) => {
    if (out.length >= max) return;
    const steps = (Array.isArray(get(o, "steps")) ? (get(o, "steps") as unknown[]) : [])
      .map((s) => chainStep(s)?.action).filter((s): s is string => Boolean(s)).slice(0, MAX_CHAIN_STEPS);
    const links = knownLinks(get(o, "links") ?? get(o, "findings"), findings);
    const goal = clipText(get(o, "goal") ?? get(o, "impact"), 400);
    if (steps.length < 2 || !links.length || !goal) return;
    const unproven = Number(get(o, "unproven") ?? get(o, "unproven_step"));
    out.push({
      title: clipText(get(o, "title"), 200) ?? goal.slice(0, 80),
      goal, links, steps,
      ...(Number.isInteger(unproven) && unproven >= 1 && unproven <= steps.length ? { unproven } : {}),
    });
  };
  for (const raw of jsonObjects(text ?? "")) {
    let o: unknown;
    try { o = JSON.parse(raw); } catch { continue; }
    const paths = get(o, "paths") ?? get(o, "chains");
    if (Array.isArray(paths)) paths.forEach(take);
    else take(o);
  }
  return out;
}

/**
 * The rules an attack path must meet whatever the verifier wrote:
 *  - a path with a step that has no evidence is partial, stopped at that step;
 *  - it is config-dependent if any finding it uses is;
 *  - a demonstrated path is never rated below the worst finding it uses (that finding
 *    stands on its own, so the path that contains it cannot be less serious).
 */
export function applyChainRules(chain: ReconChain, findings: readonly ReconFinding[]): ReconChain {
  const used = findings.filter((f) => f.id && chain.links.includes(f.id));
  const out: ReconChain = { ...chain };
  const gap = out.steps.findIndex((s) => !s.evidence);
  if (out.status === "demonstrated" && gap >= 0) {
    out.status = "partial";
    out.blockedAt = gap + 1;
    out.blockedWhy = "no evidence for this step";
  }
  if (out.status === "demonstrated") { delete out.blockedAt; delete out.blockedWhy; }
  if (used.some((f) => f.verdict === "config-dependent")) {
    out.verdict = "config-dependent";
    out.prodCaveat ??= used.map((f) => f.prodCaveat).filter(Boolean).join(" ") || "Depends on a finding that depends on a non-production setting.";
  }
  if (out.status === "demonstrated") {
    const floor = worstSeverity(used);
    if (floor && SEVERITY_RANK[floor] > SEVERITY_RANK[out.severity]) out.severity = floor;
  }
  return out;
}

/**
 * The verifier's verdicts on attack paths, from its reply. One is read only if it is valid
 * JSON marked as a path, with a known verdict and severity, two or more steps, the impact,
 * and at least one finding of this run among its links. A rejected path is dropped, and so
 * is anything unparseable: nothing is promoted on a guess. The rules above are then applied.
 */
export function parseVerifierChains(text: string, env: EnvFidelity["kind"], findings: readonly ReconFinding[]): ReconChain[] {
  const out: ReconChain[] = [];
  for (const raw of jsonObjects(text ?? "")) {
    let o: unknown;
    try { o = JSON.parse(raw); } catch { continue; }
    if (!isChainVerdict(o)) continue;
    const verdict = VERDICTS.find((v) => v === String(get(o, "verdict")).toLowerCase());
    const severity = SEVERITIES.find((s) => s === String(get(o, "severity")).toLowerCase());
    const steps = (Array.isArray(get(o, "steps")) ? (get(o, "steps") as unknown[]) : [])
      .map(chainStep).filter((s): s is ReconChainStep => Boolean(s)).slice(0, MAX_CHAIN_STEPS);
    const links = knownLinks(get(o, "links"), findings);
    const impact = clipText(get(o, "impact") ?? get(o, "goal"), 600);
    if (!verdict || verdict === "rejected" || !severity || steps.length < 2 || !links.length || !impact) continue;
    const blockedAt = Number(get(o, "blocked_at") ?? get(o, "blockedAt"));
    const partial = String(get(o, "status")).toLowerCase() === "partial";
    out.push(applyChainRules({
      title: clipText(get(o, "title"), 200) ?? impact.slice(0, 80),
      severity, verdict, impact, links, steps, env,
      status: partial ? "partial" : "demonstrated",
      ...(partial && Number.isInteger(blockedAt) && blockedAt >= 1 && blockedAt <= steps.length ? { blockedAt } : {}),
      ...(partial ? { blockedWhy: clipText(get(o, "blocked_why") ?? get(o, "blockedWhy"), 300) ?? "not demonstrated" } : {}),
      standardId: clipText(get(o, "standard_id") ?? get(o, "standardId"), 60),
      prodCaveat: clipText(get(o, "prod_caveat") ?? get(o, "prodCaveat"), 1000),
    }, findings));
  }
  return out;
}

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
  return { findings: run.findings, chains: run.chains, rounds: run.rounds, tokens: run.spentTokens, stopped };
}
