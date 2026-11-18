/**
 * Supervised recon / autopwn — the thin slice.
 * -----------------------------------------------------------------------------
 * Adds ARTEX's one genuine edge — an autonomous recon -> hypothesise -> test ->
 * confirm loop — to BugXHunter, without importing ARTEX's failure modes
 * (runaway frontier-model cost, rate-limit thrash, and reporting a config
 * artifact as a production finding).
 *
 * It does that two ways:
 *
 *   1. An intelligent, DETERMINISTIC router (`routeModel`) puts each model on the
 *      job it is good at, starts cheap, and escalates only on evidence — and
 *      sheds load off a rate-limited provider before it 429s (the exact thrash
 *      we watched ARTEX do against Mythos's 200k-input-tokens/minute cap).
 *
 *   2. Two gates ARTEX lacked: an environment-fidelity declaration that tags
 *      every finding with the environment it was seen in (so a bug that hinges
 *      on a non-prod setting is flagged "config-dependent", not shipped as a
 *      clean Medium), and a verify pass that re-checks each candidate and
 *      assigns severity before it is promoted.
 *
 * Nothing here runs blind: the agents still ride OpenCode's `permission: ask`
 * model, and `classifyCommand` lets the UI auto-allow read-only recon while
 * always pausing on anything that changes state.
 *
 * This is scaffolding: the agents and the router are wired and type-checked;
 * the driver loop that walks them and the UI that renders the risk tiers are
 * the next slice. Prompts are concise inline here and should later be built
 * from the standards catalogue in `web/src/intel` the way the Playground
 * presets are, so findings cite the same WSTG / OWASP ids everywhere.
 */

/** The four jobs in a recon run. Each maps to one model via the router. */
export type ReconRole = "executor" | "triage" | "verify" | "escalate";

/**
 * Which model takes each job, by default. Open-weight GLM does the grind;
 * Anthropic models are spent sparingly and only where judgment pays.
 * Every one is env-overridable, and every one falls back to a model that works
 * on an SCX-only install, so a runner with no Anthropic key still functions
 * (just with GLM doing triage/verify/escalate too).
 */
export const RECON_MODELS: Record<ReconRole, string> = {
  // High volume: runs the commands, reads the output, iterates. Cheap by design.
  executor: process.env.RECON_EXECUTOR_MODEL ?? "scx/GLM-5.3",
  // Fast, cheap classification: "is this response interesting? seen before?"
  triage: process.env.RECON_TRIAGE_MODEL ?? "anthropic/claude-haiku-5-5",
  // Per-candidate judgment: re-check a finding, assign severity, demand repro.
  verify: process.env.RECON_VERIFY_MODEL ?? "anthropic/claude-sonnet-5-5",
  // Rare, high-value: a stuck executor, or adversarial review of a High/Critical.
  escalate: process.env.RECON_ESCALATE_MODEL ?? "anthropic/claude-mythos-5-2",
};

/** The safe mid-tier a rate-limited or unavailable top tier sheds down to. */
const FALLBACK_MODEL = process.env.RECON_FALLBACK_MODEL ?? RECON_MODELS.verify;

/** How many failed attempts on one intent before the executor earns a stronger model. */
const ESCALATE_AFTER = Number(process.env.RECON_ESCALATE_AFTER ?? 2);

/** Signals the router reads. All optional — absence means "no reason to deviate". */
export interface RouteSignals {
  /** Failed attempts on the current intent so far. */
  attempts?: number;
  /** The executor's own read on how severe the thing it is chasing looks. */
  severityHint?: "low" | "medium" | "high" | "critical";
  /**
   * Models (or whole providers) at or near their rate limit. Anthropic's limits
   * are PER MODEL (the 429 we saw named `claude-mythos-5-2` alone), so key this
   * by the full model id to shed just that model, or by a bare provider id to
   * shed everything on a provider that is down. Both are checked.
   */
  rateLimited?: Partial<Record<string, boolean>>;
  /** Token budget left for the run; a near-empty budget avoids the pricey tier. */
  budgetRemaining?: number;
}

/**
 * The intelligent router. DETERMINISTIC on purpose — no model-as-router on the
 * hot path. It is the single place the model choice is made, so the escalation
 * and rate-limit policy lives here and nowhere else.
 *
 *   - Role is the baseline.
 *   - A stuck executor, or a High/Critical candidate, escalates to the top tier.
 *   - A rate-limited or budget-starved top tier sheds down to the mid tier
 *     BEFORE it 429s — the exact failure we saw ARTEX never handle.
 */
export function routeModel(role: ReconRole, s: RouteSignals = {}): string {
  let model = RECON_MODELS[role];

  // Escalate on evidence, not by default (ARTEX's mistake was the opposite:
  // frontier-by-default, and it never escalated DOWN to a cheap model either).
  const stuck = (s.attempts ?? 0) >= ESCALATE_AFTER;
  const grave = s.severityHint === "high" || s.severityHint === "critical";
  if (role === "executor" && (stuck || grave)) model = RECON_MODELS.escalate;

  // Shed load off a model that is at its cap, or when the budget is thin, down
  // to the mid tier — never pile onto the thing that is already 429ing. Because
  // Anthropic caps are per model, a capped Mythos still sheds to a healthy
  // Sonnet; only if the fallback is ALSO capped do we grind on GLM.
  const starved = s.budgetRemaining !== undefined && s.budgetRemaining <= 0;
  if (capped(model, s) || starved) {
    model = capped(FALLBACK_MODEL, s) ? RECON_MODELS.executor : FALLBACK_MODEL;
  }

  return model;
}

/** True if this model, or its whole provider, is flagged rate-limited. */
function capped(model: string, s: RouteSignals): boolean {
  const provider = model.split("/")[0];
  return Boolean(s.rateLimited?.[model] || s.rateLimited?.[provider]);
}

/** Shared tool posture for the read-only reviewer subagents. */
const READ_ONLY_TOOLS = { bash: false, edit: false, write: false, task: false } as const;

/**
 * The recon subagents, one per role, each pinned to its baseline model. The
 * driver loop invokes them by role; when the router escalates, it routes the
 * step to the `escalate` agent instead of `executor`. Shaped like VISION_AGENT
 * so OpenCode's inline config accepts them.
 */
export const RECON_AGENTS = {
  recon: {
    model: RECON_MODELS.executor,
    mode: "subagent",
    description:
      "Supervised recon/autopwn executor: enumerate the in-scope target, hypothesise weaknesses, test them with low-impact probes, and hand candidates to recon-verify. Read-only shell; never mutates state without an approved step.",
    prompt:
      "You are the EXECUTOR in a supervised penetration test of a single, explicitly in-scope target. Work one hypothesis at a time: enumerate -> hypothesise a specific weakness (name the OWASP/API Top 10 or WSTG id) -> test it with the smallest, lowest-impact probe that settles it -> record exactly what you observed. Prefer read-only probes (GET, HEAD, nmap -sV, DNS, reading saved responses). Anything that changes state (POST that writes, PUT, PATCH, DELETE, file writes) is a RED LINE: stop and hand it to the human for approval, with the one request you want to run and why. When you believe you have a finding, call the recon-verify subagent with the evidence — do NOT promote it yourself. Stay strictly inside the declared scope. If you are stuck after a couple of tries, say so plainly rather than widening scope.",
    tools: { bash: true, edit: false, write: false, task: true, read: true },
  },
  "recon-triage": {
    model: RECON_MODELS.triage,
    mode: "subagent",
    description:
      "Fast, cheap triage of tool output: is this response interesting, already seen, or noise? Returns a one-line verdict and the single most promising next direction.",
    prompt:
      "You triage raw tool output for the executor. In two or three sentences: is there anything security-relevant here, have we effectively seen it already, and what is the single most promising next probe? Do not run tools or speculate beyond the output you were given.",
    tools: READ_ONLY_TOOLS,
  },
  "recon-verify": {
    model: RECON_MODELS.verify,
    mode: "subagent",
    description:
      "Adversarially verifies one candidate finding against the declared environment and the standards catalogue, assigns severity, and flags config-dependent findings before they are promoted.",
    prompt:
      "You VERIFY one candidate finding. Reject it unless there is concrete reproduction evidence (the request/command and the response that proves it). Assign severity with the project's rubric and cite the matching OWASP/API/WSTG id. CRITICAL: compare the finding against the declared environment fidelity — if it depends on a setting that differs from production (an auth flag off, a debug mode on, seed data), mark it config-dependent and say exactly what to re-test against production. Output: {verdict: real|config-dependent|rejected, severity, standard_id, repro, prod_caveat}.",
    tools: READ_ONLY_TOOLS,
  },
  "recon-escalate": {
    model: RECON_MODELS.escalate,
    mode: "subagent",
    description:
      "Frontier escalation: called only when the executor is stuck or a High/Critical candidate needs deep adversarial review or multi-step exploit-chain reasoning. Read-only.",
    prompt:
      "You are the escalation reviewer, called rarely and only for hard cases: a stuck executor, or a High/Critical candidate that must survive adversarial scrutiny before it is reported. Reason carefully about exploitability and chaining, demand evidence, and be willing to downgrade or reject. Do not run tools; reason over what you are given and return a precise recommendation.",
    tools: READ_ONLY_TOOLS,
  },
} as const;

/**
 * How well the tested environment matches production. Declared by the operator
 * before a run (or fingerprinted); every finding is tagged with it so a
 * config-dependent bug is never shipped as a clean one. This is the single
 * most important fix over ARTEX, which reported a "delete any run" Medium that
 * only existed because the local instance ran without its production
 * ownership-enforcement flag.
 */
export interface EnvFidelity {
  /** Where the target runs: a local dev instance, a staging/qa env, or production. */
  kind: "local" | "staging" | "production";
  /** Human note on how it diverges from prod (env flags, seed data, auth gates). */
  divergences: string;
  /** Config keys known to differ from production, by name (e.g. "QUANTUM_SHARED"). */
  nonProdSettings?: string[];
}

/** One recon finding, tagged with the environment it was seen in. */
export interface ReconFinding {
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  /** The OWASP/API/WSTG id it maps to. */
  standardId?: string;
  /** The request/command and response that reproduce it. */
  repro: string;
  verdict: "real" | "config-dependent" | "rejected";
  /** Set when verdict is config-dependent: what to re-test against production. */
  prodCaveat?: string;
  /** The environment this was found in. */
  env: EnvFidelity["kind"];
}

/**
 * Risk tier for one shell command: may the UI auto-allow it, or must a human
 * approve? Read-only recon flows without a click; anything that could change
 * state, exfiltrate, or escape scope always asks. This is the middle path
 * between ARTEX's "approve everything" (unusably slow) and "approve nothing"
 * (unsafe). Conservative by construction: unknown shapes ask.
 */
export function classifyCommand(command: string): "allow" | "ask" {
  // Work on the original string: `-X`/`-F` (mutating) vs `-x`/`-f` (benign) only
  // differ by case, so lower-casing would lose that. Keyword matches use /i.
  const c = command;

  // State-changing, outbound, or destructive: always ask. Checked first, so a
  // read verb buried in a mutating command can never win.
  const MUTATING: RegExp[] = [
    /(?:^|\s)-X\s*(?:POST|PUT|PATCH|DELETE)\b/i, // curl -X POST/PUT/PATCH/DELETE
    /--request[=\s]+(?:POST|PUT|PATCH|DELETE)\b/i,
    /(?:^|\s)-d(?:[=\s']|$)|--data(?:-raw|-binary|-urlencode)?\b/, // sending a body
    /(?:^|\s)-F\b|--form\b/, // multipart upload (note: case-sensitive -F)
    /\b(?:rm|mv|dd|mkfs|truncate|shred)\b/i, // destructive filesystem ops
    /\b(?:chmod|chown|kill|pkill|shutdown|reboot)\b/i,
    /\b(?:nc|ncat|netcat)\b/i, // raw sockets / possible reverse shell
    /\b(?:ssh|scp|sftp)\b/i, // moving off-box
  ];
  if (MUTATING.some((re) => re.test(c))) return "ask";

  // Read-only recon we trust to flow without a click. (Any mutating curl has
  // already returned "ask" above, so a bare curl here is a GET/HEAD.)
  const READ_ONLY: RegExp[] = [
    /(?:^|\s)curl\b/i,
    /(?:^|\s)(?:wget|http|https)\b/i,
    /(?:^|\s)nmap\b/i,
    /(?:^|\s)(?:dig|nslookup|host|whois)\b/i,
    /(?:^|\s)(?:cat|head|tail|less|grep|rg|awk)\b/i,
    /(?:^|\s)(?:ls|find|stat|file|wc)\b/i,
    /(?:^|\s)(?:echo|printf|jq|tr|sort|uniq|cut)\b/i,
  ];
  if (READ_ONLY.some((re) => re.test(c))) return "allow";

  // Anything we do not recognise: ask. Fail closed.
  return "ask";
}
