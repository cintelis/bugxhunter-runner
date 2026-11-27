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
  routeModel, harnessFor, classifyCommand, commandHazard, allCapped, originOf, escalateAfter, resolveChainPass, STATUS_LINE,
  type ReconFinding, type ReconChain, type ReconChainStep, type ChainCandidate,
  type EnvFidelity, type ReconHarness, type RouteSignals, type GateContext,
} from "./recon.js";

type Severity = ReconFinding["severity"];
const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const worstSeverity = (fs: readonly Pick<ReconFinding, "severity" | "verdict">[]): Severity | undefined => {
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
  /** Turns the chain pass took (not counted in `rounds`, which caps the main loop). */
  chainRounds = 0;
  /** Consecutive turns the executor reported stuck — the escalation signal. */
  attempts = 0;
  readonly findings: ReconFinding[] = [];
  /** Attack paths the verifier ruled on, in the main loop or the chain pass: demonstrated ones and partial leads. */
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
  /** Is the budget spent, counting `reserve` tokens as already gone (the main loop leaves them for the chain pass)? */
  outOfBudget(reserve = 0): boolean { const r = this.budgetRemaining(); return r !== undefined && r - reserve <= 0; }
  /**
   * Tokens the main loop leaves for the chain pass: a share of the budget, held back only
   * once the run has the two findings the pass needs. Without them there will be no pass,
   * and the main loop may spend the whole budget as before.
   */
  chainReserve(): number {
    const c = resolveChainPass(this.harness.chainPass);
    if (!c.enabled || this.findings.length < 2 || this.harness.budgetTokens === undefined) return 0;
    return Math.floor(this.harness.budgetTokens * c.reservePercent / 100);
  }
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
  /** What the executor wrote this turn (the chain pass reads the proposed paths from it). */
  text?: string;
  /** The verifier's replies this turn, as written (the chain pass reads its verdicts on paths from them). */
  verifierOutputs?: string[];
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
  /** Called when the chain pass starts, and again each time it records a path. */
  onChainPass?: (chains: readonly ReconChain[]) => void;
  /** Called when the main loop records an attack path: the executor followed a finding up and the verifier ruled on it. */
  onChains?: (chains: readonly ReconChain[]) => void;
}

/**
 * How the chain pass went. `ran`: paths were proposed and tried. Not run: `off` (turned off),
 * `skipped` (the main loop ended on an error or on rate limits), `few-findings` (fewer than
 * two), `budget` (no tokens left), `no-paths` (nothing was proposed that builds on a finding),
 * `rate-limited`. `error`: it started and a turn failed; what it had recorded is kept.
 */
export type ChainPassOutcome = "ran" | "off" | "skipped" | "few-findings" | "budget" | "no-paths" | "rate-limited" | "error";

export interface ReconRunResult {
  findings: ReconFinding[];
  /** Attack paths from the chain pass (none until the pass runs). */
  chains: ReconChain[];
  chainPass: ChainPassOutcome;
  /** Rounds of the main loop. The chain pass's turns are counted apart, in `chainRounds`. */
  rounds: number;
  chainRounds: number;
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

const NEXT_HYPOTHESIS =
  "take the next untested hypothesis within scope. If the in-scope surface is genuinely exhausted, stop and say so rather than widening scope. Hand any new candidate to recon-verify.";

/** Prompt that nudges the executor forward after a turn goes idle with work left, while nothing is verified yet. */
export const RECON_CONTINUE = `Continue: ${NEXT_HYPOTHESIS} ${STATUS_REMINDER}`;

/** The most findings and paths a continue prompt lists: the newest ones, since those are the ones not yet followed up. */
const MAX_LISTED = 30;

const oneLine = (t: string, n: number) => { const one = t.replace(/\s+/g, " ").trim(); return one.length > n ? one.slice(0, n) + "…" : one; };
const findingHead = (f: ReconFinding) => `${f.id} [${f.severity}${f.verdict === "config-dependent" ? ", config-dependent" : ""}] ${oneLine(f.title, 160)}`;
const chainHead = (c: ReconChain) => `${c.id} [${c.status}] ${oneLine(c.title, 160)} (${c.links.join(", ")})`;

/**
 * The prompt for the next round of the main loop. Once something is verified, the round
 * starts from what it unlocks before it moves to a fresh hypothesis: a path that needs a
 * step nobody took cannot be shown later, in the few rounds the chain pass has. The titles
 * are enough here: the session already holds each finding's evidence.
 */
export function buildReconContinue(findings: readonly ReconFinding[], chains: readonly ReconChain[] = []): string {
  if (!findings.length) return RECON_CONTINUE;
  const paths = chains.length ? `Attack paths already recorded (do not repeat them):\n${chains.slice(-MAX_LISTED).map(chainHead).join("\n")}` : "";
  return [
    "Continue: first see what the verified findings unlock.",
    `Verified so far:\n${findings.slice(-MAX_LISTED).map(findingHead).join("\n")}`,
    ...(paths ? [paths] : []),
    "Ask what these give an attacker that has not been used yet: a credential, a token, an identifier, an internal address, a level of access. If one of them is what a further step needs, that step is inside the scope and it has not been tried, take it now with the smallest probe, using what the earlier step returned. The same rules apply: read-only probes run freely, anything that changes state pauses for human approval.",
    "If the step reaches something worse than the finding it builds on, hand the whole sequence to recon-verify as an ATTACK PATH: for each step the request or command and the response, the finding ids it builds on, and what the attacker ends up with. Do not promote it yourself.",
    `If nothing follows from them, ${NEXT_HYPOTHESIS}`,
    STATUS_REMINDER,
  ].join("\n\n");
}

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

/* ─────────────── the chain pass ─────────────── */

const clipLine = (t: string, n: number) => { const one = t.replace(/\s+/g, " ").trim(); return one.length > n ? one.slice(0, n) + "…" : one; };
const findingLine = (f: ReconFinding) => `${f.id} [${f.severity}${f.verdict === "config-dependent" ? ", config-dependent" : ""}] ${clipLine(f.title, 160)}: ${clipLine(f.repro, 300)}`;

/** The proposal turn: no tools, just which of the verified findings combine. */
export function buildChainProposalPrompt(findings: readonly ReconFinding[], max: number, recorded: readonly ReconChain[] = []): string {
  return [
    "CHAIN PASS. The assessment loop has ended. Do not run any tool in this turn.",
    `Verified findings of this run:\n${findings.map(findingLine).join("\n")}`,
    ...(recorded.length ? [`Attack paths already recorded in this run. Do not propose them again, and do not propose one that only restates them:\n${recorded.map(chainHead).join("\n")}`] : []),
    `From these, and from anything you observed during this run, propose up to ${max} attack paths: sequences in which what one step returns is what the next step needs, and which reach something worse than any single finding does. Stay inside the declared scope. Every path must build on at least one finding above, named by its id. Put the most valuable path first. If nothing combines, say so and give an empty list.`,
    'Output one fenced json block and nothing after it: {"paths": [{"title": "short name", "goal": "what the attacker ends up with", "links": ["F1", "F3"], "steps": ["step 1", "step 2"], "unproven": the number of the step you are least sure of, or null}]}.',
  ].join("\n\n");
}

/** The first turn on one path: show it end to end, then have the verifier rule on it. */
export function buildChainDemoPrompt(c: ChainCandidate, n: number, of: number, findings: readonly ReconFinding[]): string {
  const used = findings.filter((f) => f.id && c.links.includes(f.id));
  return [
    `ATTACK PATH ${n} of ${of}: ${c.title}`,
    `Goal: ${c.goal}`,
    `Builds on:\n${used.map(findingLine).join("\n")}`,
    `Steps as proposed:\n${c.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}${c.unproven ? `\nStep ${c.unproven} is the one that has not been shown.` : ""}`,
    "Show this path end to end against the target, inside the same scope. Run each step with the smallest probe that settles it, using what the step before returned. Test nothing that is not on this path. Read-only probes run freely; a step that changes state pauses for human approval, and if it is declined the path stops there.",
    "Then hand the whole path to recon-verify as an ATTACK PATH: for each step the request or command and the response, the finding ids it builds on, and what the attacker ends up with. If a step could not be shown, hand it over all the same and say which step and why: it is recorded as partial. Do not promote the path yourself.",
    `End your turn with one final line: "${STATUS_LINE}: done" once the verifier has ruled on this path, "${STATUS_LINE}: continue" if it needs more probes, "${STATUS_LINE}: stuck" if it cannot be shown.`,
  ].join("\n\n");
}

export const CHAIN_CONTINUE =
  `Continue with this attack path only: run the next step, then hand the whole path to recon-verify as an ATTACK PATH. End with "${STATUS_LINE}: done" once the verifier has ruled, "${STATUS_LINE}: continue" or "${STATUS_LINE}: stuck".`;

/** A proposed path nothing ruled on, kept as a lead: partial, rated as the worst finding it builds on. */
function leadFrom(c: ChainCandidate, findings: readonly ReconFinding[], env: EnvFidelity["kind"], why: string): ReconChain {
  const used = findings.filter((f) => f.id && c.links.includes(f.id));
  return applyChainRules({
    title: c.title, impact: c.goal, links: c.links, env,
    severity: worstSeverity(used) ?? "low", verdict: "real",
    steps: c.steps.map((action) => ({ action })),
    status: "partial", blockedWhy: why,
    ...(c.unproven ? { blockedAt: c.unproven } : {}),
  }, findings);
}

/**
 * The chain pass: one turn to propose attack paths from the verified findings, then a few
 * turns on each to show it and have the verifier rule. Same runner, same gate and same
 * scope as the main loop; the pass can spend what is left of the token budget and no more.
 * A path the verifier did not rule on is kept as a partial lead that says why.
 */
async function driveChainPass(run: ReconRun, opts: ReconDriverOptions, gate: (p: ReconPermission) => GateDecision, harness: ReconHarness): Promise<ChainPassOutcome> {
  const cfg = resolveChainPass(harness.chainPass);
  if (!cfg.enabled) return "off";
  if (run.findings.length < 2) return "few-findings";
  if (run.outOfBudget()) return "budget";
  const env = opts.env.kind;
  const signals = (severityHint?: Severity) => run.signals({ rateLimited: opts.rateLimited?.(), severityHint });
  const record = (chains: readonly ReconChain[]) => { run.addChains(chains); opts.onChainPass?.(run.chains); };
  const turn = async (prompt: string, model: string) => {
    const res = await opts.runner.runTurn({ prompt, model, gate });
    run.chainRounds += 1;
    run.recordUsage(res.tokensUsed);
    run.addFindings(res.findings); // a new finding met on the way is kept like any other
    return res;
  };

  if (allCapped(signals())) return "rate-limited";
  opts.onChainPass?.(run.chains);
  let candidates: ChainCandidate[];
  try {
    const res = await turn(buildChainProposalPrompt(run.findings, cfg.maxCandidates, run.chains), routeModel("escalate", signals()));
    candidates = parseChainProposal(res.text ?? "", run.findings, cfg.maxCandidates);
  } catch {
    return "error";
  }
  if (!candidates.length) return "no-paths";

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const rest = (why: string) => record(candidates.slice(i).map((x) => leadFrom(x, run.findings, env, why)));
    if (run.outOfBudget()) { rest("not tried: the token budget was spent"); return "ran"; }
    run.resetAttempts();
    // A path through a High or Critical finding gets the escalation model, as such a finding does in the main loop.
    const grave = worstSeverity(run.findings.filter((f) => f.id && c.links.includes(f.id)));
    let prompt = buildChainDemoPrompt(c, i + 1, candidates.length, run.findings);
    let ruled = false, why = `not shown within ${cfg.maxRoundsPerChain} rounds`;
    for (let round = 0; round < cfg.maxRoundsPerChain; round++) {
      if (run.outOfBudget()) { why = "not shown: the token budget was spent"; break; }
      const s = signals(grave);
      if (allCapped(s)) { rest("not tried: every model was rate-limited"); return "rate-limited"; }
      let res: ReconTurnResult;
      try {
        res = await turn(prompt, routeModel("executor", s));
      } catch {
        rest("not tried: the run stopped");
        return "error";
      }
      const chains = (res.verifierOutputs ?? []).flatMap((out) => parseVerifierChains(out, env, run.findings));
      if (chains.length) { record(chains); ruled = true; break; }
      if (res.stuck) { run.recordStuck(); why = "the executor could not show it"; break; }
      if (res.done) { why = "the verifier did not rule on it"; break; }
      if (!res.madeProgress) { why = "the executor made no progress on it"; break; }
      prompt = CHAIN_CONTINUE;
    }
    if (!ruled) record([leadFrom(c, run.findings, env, why)]);
  }
  return "ran";
}

/** The main loop: route the executor each round, run a turn under the gate, stop on done / idle / a cap. */
async function driveMainLoop(run: ReconRun, opts: ReconDriverOptions, gate: (p: ReconPermission) => GateDecision): Promise<ReconRunResult["stopped"]> {
  const maxStuck = escalateAfter() + 2; // give escalation a chance before giving up
  let prompt = buildReconKickoff(opts);
  // One-shot: the worst severity found LAST turn informs THIS turn's routing, then clears.
  let severityHint: Severity | undefined;

  for (;;) {
    const signals = run.signals({ rateLimited: opts.rateLimited?.(), severityHint });
    // Every model is rate-limited — back off rather than thrash (H4).
    if (allCapped(signals)) return "rate-limited";

    const model = routeModel("executor", signals);
    let res: ReconTurnResult;
    try {
      res = await opts.runner.runTurn({ prompt, model, gate });
    } catch {
      return "error"; // keep the findings gathered so far (M2)
    }

    run.recordRound();
    run.recordUsage(res.tokensUsed);
    run.addFindings(res.findings);
    // A path the executor showed while following a finding up, ruled on by the verifier like any other.
    const paths = (res.verifierOutputs ?? []).flatMap((out) => parseVerifierChains(out, opts.env.kind, run.findings));
    if (paths.length) { run.addChains(paths); opts.onChains?.(run.chains); }
    severityHint = worstSeverity([...res.findings, ...paths.filter((c) => c.status === "demonstrated")]);
    if (res.stuck) run.recordStuck(); else run.resetAttempts();

    if (res.done) return "done";                                    // a clean finish wins over the caps
    if (run.outOfBudget(run.chainReserve())) return "budget";       // what is held back is for the chain pass
    if (run.outOfRounds()) return "rounds";
    if (run.attempts >= maxStuck) return "stuck";                   // persistently stuck, even escalated (H3)
    if (!res.madeProgress && !res.stuck) return "idle";             // surface spent

    prompt = buildReconContinue(run.findings, run.chains);
  }
}

/**
 * Drive one supervised recon run to completion. Pure control flow over the
 * injected runner: the main loop (route and escalate the executor model each
 * round, run a turn under the gate, fold in usage and findings, stop on done /
 * idle / budget / rounds), then the chain pass over what it found. The harness
 * for the executor role supplies the caps.
 */
export async function driveRecon(opts: ReconDriverOptions): Promise<ReconRunResult> {
  const harness = resolveHarness(opts.harness);
  const run = new ReconRun(harness);
  const { host: scopeHost, port: scopePort } = originOf(opts.scope);
  const gate = (p: ReconPermission) => reconGateDecision(p, { scopeHost, scopePort });
  const stopped = await driveMainLoop(run, opts, gate);
  // An error (which is also how a stop by the person arrives) or rate limits end the run: no pass.
  const chainPass = stopped === "error" || stopped === "rate-limited" ? "skipped" : await driveChainPass(run, opts, gate, harness);
  return { findings: run.findings, chains: run.chains, chainPass, rounds: run.rounds, chainRounds: run.chainRounds, tokens: run.spentTokens, stopped };
}
