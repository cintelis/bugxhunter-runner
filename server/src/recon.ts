/**
 * Supervised recon / autopwn — the thin slice.
 * -----------------------------------------------------------------------------
 * Adds ARTEX's one genuine edge — an autonomous recon -> hypothesise -> test ->
 * confirm loop — to BugXHunter, without importing ARTEX's failure modes
 * (runaway frontier-model cost, rate-limit thrash, and reporting a config
 * artifact as a production finding).
 *
 * Routing follows a roles x profiles x harness design (the general pattern from
 * the public aider / Claude Code / Roo multi-model research, reimplemented here
 * from scratch for pentest roles):
 *
 *   - ROLES are the four fixed jobs in a run: executor / triage / verify /
 *     escalate. The orchestrator shifts between them.
 *   - A PROFILE bolts a model into each role. Users pick one, or define their
 *     own in a JSON file (RECON_PROFILES_FILE) — a typo degrades to a built-in,
 *     never a crash.
 *   - A per-role HARNESS tunes HOW a role runs (token budget, round cap, tool
 *     surface, effort), not just which model — the lever that keeps an
 *     autonomous loop from running away (the ARTEX cost blowout).
 *
 * On top of that, two things the coding-oriented routers don't need and ARTEX
 * lacked:
 *   - `routeModel` sheds a rate-limited model down a tier (per model, since the
 *     429 we saw named `claude-mythos-5-2` alone) instead of thrashing.
 *   - `EnvFidelity` tags every finding with the environment it was seen in, so a
 *     bug that hinges on a non-prod setting is flagged "config-dependent", not
 *     shipped as a clean Medium.
 *
 * Nothing here runs blind: the agents still ride OpenCode's `permission: ask`
 * model, and `classifyCommand` lets the UI auto-allow read-only recon while
 * always pausing on anything that changes state.
 *
 * Scaffolding: the roles, profiles and router are wired and type-checked; the
 * driver loop that walks them (and reads the harness) and the UI are the next
 * slice. Prompts are concise inline here and should later be built from the
 * standards catalogue in `web/src/intel` so findings cite the same WSTG / OWASP
 * ids everywhere.
 */

import { readFileSync } from "node:fs";

/** The four jobs in a recon run. Each is bolted to a model by the active profile. */
export type ReconRole = "executor" | "triage" | "verify" | "escalate";

const ROLES: readonly ReconRole[] = ["executor", "triage", "verify", "escalate"];

/** Reasoning effort a role is driven at. */
export type ReconEffort = "low" | "medium" | "high";

/**
 * How a role runs, beyond which model it is. Every field is optional and an
 * absent field means today's default. The driver loop reads these when it
 * invokes a role; the OpenCode agent config only carries model + tools.
 */
export interface ReconHarness {
  /** Uncached input tokens one delegation may spend before it stops (the cost cap). */
  budgetTokens?: number;
  /** Tool-call rounds before a role stops and reports. */
  maxRounds?: number;
  /** Tool surface: `full`, or `core` — a minimal read-only-plus-shell recon set. */
  tools?: "full" | "core";
  /** Reasoning effort sent for the role. */
  effort?: ReconEffort;
}

/** A profile assigns a model to each role and, optionally, a harness to each. */
export interface ReconProfile {
  models: Record<ReconRole, string>;
  harness?: Partial<Record<ReconRole, ReconHarness>>;
}

/**
 * Built-in profiles, cheap -> capable. Every model id is `provider/model` the
 * way OpenCode addresses it; `scx/*` is open-weight, `anthropic/*` is Claude.
 * The default spends open-weight GLM on the grind and Claude only where judgment
 * pays. `recon-open` keeps a key-less, SCX-only install fully working.
 */
export const BUILTIN_PROFILES: Record<string, ReconProfile> = {
  // All open-weight. Nothing leaves SCX; no Anthropic key needed.
  "recon-open": {
    models: { executor: "scx/GLM-5.3", triage: "scx/GLM-5.3-Flash", verify: "scx/GLM-5.3", escalate: "scx/GLM-5.3" },
    harness: {
      executor: { tools: "core", maxRounds: 80, budgetTokens: 3_000_000 },
      triage: { tools: "core" },
      verify: { tools: "core" },
      escalate: { tools: "core" },
    },
  },
  // Default. GLM grinds; Haiku triages; Sonnet verifies; Mythos escalates rarely.
  "recon-balanced": {
    models: { executor: "scx/GLM-5.3", triage: "anthropic/claude-haiku-5-5", verify: "anthropic/claude-sonnet-5-5", escalate: "anthropic/claude-mythos-5-2" },
    harness: {
      executor: { tools: "core", maxRounds: 60, budgetTokens: 2_000_000, effort: "medium" },
      triage: { tools: "core" },
      verify: { tools: "core", effort: "high" },
      escalate: { tools: "core", effort: "high" },
    },
  },
  // For hard targets: a Claude executor too, Opus verifying.
  "recon-quality": {
    models: { executor: "anthropic/claude-sonnet-5-5", triage: "anthropic/claude-haiku-5-5", verify: "anthropic/claude-opus-5-5", escalate: "anthropic/claude-mythos-5-2" },
    harness: {
      executor: { tools: "core", maxRounds: 50, budgetTokens: 2_000_000, effort: "high" },
      triage: { tools: "core" },
      verify: { tools: "core", effort: "high" },
      escalate: { tools: "core", effort: "high" },
    },
  },
};

export const DEFAULT_PROFILE = "recon-balanced";

/** Parse one role's harness from a user profile; unknown/invalid fields drop. */
export function parseReconHarness(raw: unknown): ReconHarness | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const h: ReconHarness = {};
  if (typeof r.budgetTokens === "number" && r.budgetTokens >= 1) h.budgetTokens = Math.floor(r.budgetTokens);
  if (typeof r.maxRounds === "number" && r.maxRounds >= 1) h.maxRounds = Math.floor(r.maxRounds);
  if (r.tools === "full" || r.tools === "core") h.tools = r.tools;
  if (r.effort === "low" || r.effort === "medium" || r.effort === "high") h.effort = r.effort;
  return Object.keys(h).length ? h : undefined;
}

/** Parse a user profile; null unless every role names a model. */
export function parseProfile(def: unknown): ReconProfile | null {
  if (!def || typeof def !== "object") return null;
  const d = def as Record<string, unknown>;
  const rawModels = d.models;
  if (!rawModels || typeof rawModels !== "object") return null;
  const m = rawModels as Record<string, unknown>;
  const models = {} as Record<ReconRole, string>;
  for (const role of ROLES) {
    if (typeof m[role] !== "string" || !m[role]) return null;
    models[role] = m[role] as string;
  }
  const harness: Partial<Record<ReconRole, ReconHarness>> = {};
  if (d.harness && typeof d.harness === "object") {
    for (const role of ROLES) {
      const h = parseReconHarness((d.harness as Record<string, unknown>)[role]);
      if (h) harness[role] = h;
    }
  }
  return Object.keys(harness).length ? { models, harness } : { models };
}

/** Built-ins merged with any user profiles from RECON_PROFILES_FILE (a JSON map). */
export function loadProfiles(): Record<string, ReconProfile> {
  const merged: Record<string, ReconProfile> = { ...BUILTIN_PROFILES };
  const file = (process.env.RECON_PROFILES_FILE || "").trim();
  if (!file) return merged;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const [name, def] of Object.entries(parsed)) {
      const p = parseProfile(def);
      if (p) merged[name] = p;
    }
  } catch {
    /* no file / bad json -> built-ins only */
  }
  return merged;
}

/** Active profile name: RECON_PROFILE env, else the default. */
export function activeProfileName(): string {
  return (process.env.RECON_PROFILE || "").trim() || DEFAULT_PROFILE;
}

export function activeProfile(): ReconProfile {
  return loadProfiles()[activeProfileName()] ?? BUILTIN_PROFILES[DEFAULT_PROFILE];
}

export function profileNames(): string[] {
  return Object.keys(loadProfiles());
}

/** Per-role env override, highest precedence (RECON_EXECUTOR_MODEL, …). */
const ROLE_ENV: Record<ReconRole, string> = {
  executor: "RECON_EXECUTOR_MODEL",
  triage: "RECON_TRIAGE_MODEL",
  verify: "RECON_VERIFY_MODEL",
  escalate: "RECON_ESCALATE_MODEL",
};

/** The model for a role: env override > active profile. */
export function modelFor(role: ReconRole): string {
  return (process.env[ROLE_ENV[role]] || "").trim() || activeProfile().models[role];
}

/** The harness for a role under the active profile ({} = defaults). */
export function harnessFor(role: ReconRole): ReconHarness {
  return activeProfile().harness?.[role] ?? {};
}

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
 * hot path. One place the model choice is made, so escalation and rate-limit
 * policy live here and nowhere else.
 *
 *   - Role is the baseline (from the active profile).
 *   - A stuck executor, or a High/Critical candidate, escalates to the top tier.
 *   - A rate-limited or budget-starved model sheds down a tier BEFORE it 429s.
 */
export function routeModel(role: ReconRole, s: RouteSignals = {}): string {
  let model = modelFor(role);

  // Escalate on evidence, not by default (ARTEX's mistake was the opposite:
  // frontier-by-default, and it never escalated DOWN to a cheap model either).
  const stuck = (s.attempts ?? 0) >= ESCALATE_AFTER;
  const grave = s.severityHint === "high" || s.severityHint === "critical";
  if (role === "executor" && (stuck || grave)) model = modelFor("escalate");

  // Shed load off a capped model, or when the budget is spent, down to the mid
  // tier (verify). Per-model aware, so a capped Mythos still sheds to a healthy
  // Sonnet; only if the fallback is ALSO capped do we grind on the executor model.
  const starved = s.budgetRemaining !== undefined && s.budgetRemaining <= 0;
  if (capped(model, s) || starved) {
    const fallback = modelFor("verify");
    model = capped(fallback, s) ? modelFor("executor") : fallback;
  }

  return model;
}

/** True if this model, or its whole provider, is flagged rate-limited. */
function capped(model: string, s: RouteSignals): boolean {
  const provider = model.split("/")[0];
  return Boolean(s.rateLimited?.[model] || s.rateLimited?.[provider]);
}

/** Read-only tool posture for the reviewer roles. */
const READ_ONLY_TOOLS = { bash: false, edit: false, write: false, task: false } as const;

/** The executor's tools, widened to edit/write only when its harness says `full`. */
function executorTools(): Record<string, boolean> {
  const full = harnessFor("executor").tools === "full";
  return { bash: true, read: true, task: true, edit: full, write: full };
}

/** One recon subagent definition in OpenCode's inline-config shape. */
function subagent(model: string, description: string, prompt: string, tools: Record<string, boolean>) {
  return { model, mode: "subagent" as const, description, prompt, tools };
}

/**
 * The recon subagents, one per role, each bolted to the active profile's model
 * for that role. The driver loop invokes them by role and applies the harness
 * (budget/rounds/effort); when the router escalates, it routes the step to the
 * escalate agent instead of recon.
 */
export const RECON_AGENTS = {
  recon: subagent(
    modelFor("executor"),
    "Supervised recon/autopwn executor: enumerate the in-scope target, hypothesise weaknesses, test them with low-impact probes, and hand candidates to recon-verify. Read-only shell; never mutates state without an approved step.",
    "You are the EXECUTOR in a supervised penetration test of a single, explicitly in-scope target. Work one hypothesis at a time: enumerate -> hypothesise a specific weakness (name the OWASP/API Top 10 or WSTG id) -> test it with the smallest, lowest-impact probe that settles it -> record exactly what you observed. Prefer read-only probes (GET, HEAD, nmap -sV, DNS, reading saved responses). Anything that changes state (POST that writes, PUT, PATCH, DELETE, file writes) is a RED LINE: stop and hand it to the human for approval, with the one request you want to run and why. When you believe you have a finding, call the recon-verify subagent with the evidence — do NOT promote it yourself. Stay strictly inside the declared scope. If you are stuck after a couple of tries, say so plainly rather than widening scope.",
    executorTools(),
  ),
  "recon-triage": subagent(
    modelFor("triage"),
    "Fast, cheap triage of tool output: is this response interesting, already seen, or noise? Returns a one-line verdict and the single most promising next direction.",
    "You triage raw tool output for the executor. In two or three sentences: is there anything security-relevant here, have we effectively seen it already, and what is the single most promising next probe? Do not run tools or speculate beyond the output you were given.",
    READ_ONLY_TOOLS,
  ),
  "recon-verify": subagent(
    modelFor("verify"),
    "Adversarially verifies one candidate finding against the declared environment and the standards catalogue, assigns severity, and flags config-dependent findings before they are promoted.",
    "You VERIFY one candidate finding. Reject it unless there is concrete reproduction evidence (the request/command and the response that proves it). Assign severity with the project's rubric and cite the matching OWASP/API/WSTG id. CRITICAL: compare the finding against the declared environment fidelity — if it depends on a setting that differs from production (an auth flag off, a debug mode on, seed data), mark it config-dependent and say exactly what to re-test against production. Output: {verdict: real|config-dependent|rejected, severity, standard_id, repro, prod_caveat}.",
    READ_ONLY_TOOLS,
  ),
  "recon-escalate": subagent(
    modelFor("escalate"),
    "Frontier escalation: called only when the executor is stuck or a High/Critical candidate needs deep adversarial review or multi-step exploit-chain reasoning. Read-only.",
    "You are the escalation reviewer, called rarely and only for hard cases: a stuck executor, or a High/Critical candidate that must survive adversarial scrutiny before it is reported. Reason carefully about exploitability and chaining, demand evidence, and be willing to downgrade or reject. Do not run tools; reason over what you are given and return a precise recommendation.",
    READ_ONLY_TOOLS,
  ),
};

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
 * state, exfiltrate, or escape scope always asks. The middle path between
 * ARTEX's "approve everything" (unusably slow) and "approve nothing" (unsafe).
 * Conservative by construction: unknown shapes ask.
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
    /(?:^|\s)-F\b|--form\b/, // multipart form upload (note: case-sensitive -F)
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
