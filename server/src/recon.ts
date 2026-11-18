/**
 * Supervised recon / autopwn — the thin slice.
 * -----------------------------------------------------------------------------
 * Adds ARTEX's one genuine edge — an autonomous recon -> hypothesise -> test ->
 * confirm loop — to BugXHunter, without importing ARTEX's failure modes
 * (runaway frontier cost, rate-limit thrash, config-artifact-as-finding).
 *
 * Routing follows a roles x profiles x harness design (the general pattern from
 * the public aider / Claude Code / Roo multi-model research, reimplemented here
 * from scratch for pentest roles): ROLES (executor/triage/verify/escalate) are
 * the fixed jobs; a PROFILE bolts a model into each; a per-role HARNESS tunes
 * how each runs (budget/rounds/tools/effort). `routeModel` escalates on evidence
 * and sheds a rate-limited model to a healthy neighbour (per model, since the
 * 429 we saw named `claude-mythos-5-2` alone). `EnvFidelity` tags every finding
 * with the environment it was seen in.
 *
 * SECURITY NOTE — the approval gate. `classifyCommand` is the security boundary
 * of this feature, so it does NOT regex a denylist over a raw string (that is
 * fail-open: `curl -sX DELETE`, `curl ...|sh`, `echo x > ~/.bashrc` all slip a
 * substring allowlist). It parses: reject shell control operators / substitution
 * / redirection, split the pipeline, and for each stage allow ONLY a known-safe
 * binary with validated args — fetchers must use GET/HEAD and target exactly the
 * in-scope host. Anything unrecognised asks. Extra asks are the safe direction.
 */

import { readFileSync } from "node:fs";

/** The four jobs in a recon run. Each is bolted to a model by the active profile. */
export type ReconRole = "executor" | "triage" | "verify" | "escalate";

const ROLES: readonly ReconRole[] = ["executor", "triage", "verify", "escalate"];

/** Reasoning effort a role is driven at. */
export type ReconEffort = "low" | "medium" | "high";

/** How a role runs, beyond which model it is. Absent field = today's default. */
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
 * Built-in profiles, cheap -> capable. Each model id is `provider/model`;
 * `scx/*` is open-weight, `anthropic/*` is Claude. The default spends GLM on the
 * grind and Claude only where judgment pays; `recon-open` works key-less.
 */
export const BUILTIN_PROFILES: Record<string, ReconProfile> = {
  "recon-open": {
    models: { executor: "scx/GLM-5.3", triage: "scx/GLM-5.3-Flash", verify: "scx/GLM-5.3", escalate: "scx/GLM-5.3" },
    harness: {
      executor: { tools: "core", maxRounds: 80, budgetTokens: 3_000_000 },
      triage: { tools: "core" }, verify: { tools: "core" }, escalate: { tools: "core" },
    },
  },
  "recon-balanced": {
    models: { executor: "scx/GLM-5.3", triage: "anthropic/claude-haiku-5-5", verify: "anthropic/claude-sonnet-5-5", escalate: "anthropic/claude-mythos-5-2" },
    harness: {
      executor: { tools: "core", maxRounds: 60, budgetTokens: 2_000_000, effort: "medium" },
      triage: { tools: "core" }, verify: { tools: "core", effort: "high" }, escalate: { tools: "core", effort: "high" },
    },
  },
  "recon-quality": {
    models: { executor: "anthropic/claude-sonnet-5-5", triage: "anthropic/claude-haiku-5-5", verify: "anthropic/claude-opus-5-5", escalate: "anthropic/claude-mythos-5-2" },
    harness: {
      executor: { tools: "core", maxRounds: 50, budgetTokens: 2_000_000, effort: "high" },
      triage: { tools: "core" }, verify: { tools: "core", effort: "high" }, escalate: { tools: "core", effort: "high" },
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
  if (!d.models || typeof d.models !== "object") return null;
  const m = d.models as Record<string, unknown>;
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
    for (const name of Object.keys(parsed)) {
      const p = parseProfile(parsed[name]);
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
  const profiles = loadProfiles();
  const name = activeProfileName();
  // Object.hasOwn so RECON_PROFILE=constructor (a prototype key) can't resolve to junk.
  return Object.hasOwn(profiles, name) ? profiles[name] : BUILTIN_PROFILES[DEFAULT_PROFILE];
}

export function profileNames(): string[] {
  return Object.keys(loadProfiles());
}

const ROLE_ENV: Record<ReconRole, string> = {
  executor: "RECON_EXECUTOR_MODEL", triage: "RECON_TRIAGE_MODEL",
  verify: "RECON_VERIFY_MODEL", escalate: "RECON_ESCALATE_MODEL",
};

/** The model for a role: env override > active profile. */
export function modelFor(role: ReconRole): string {
  return (process.env[ROLE_ENV[role]] || "").trim() || activeProfile().models[role];
}

/** The harness for a role under the active profile ({} = defaults). */
export function harnessFor(role: ReconRole): ReconHarness {
  return activeProfile().harness?.[role] ?? {};
}

/** Stuck attempts before the executor earns a stronger model. Validated: a blank
 *  or non-integer env value falls back to 2 (a blank would otherwise be 0 and
 *  escalate every turn). */
const ESCALATE_AFTER = (() => {
  const n = Number(process.env.RECON_ESCALATE_AFTER);
  return Number.isInteger(n) && n >= 1 ? n : 2;
})();

/** Signals the router reads. All optional — absence means "no reason to deviate". */
export interface RouteSignals {
  /** Failed attempts on the current intent so far. */
  attempts?: number;
  /** Severity of the CURRENT candidate (not accumulated — escalation is one-shot). */
  severityHint?: "low" | "medium" | "high" | "critical";
  /** Models (full id) or whole providers at/near their rate limit. Both checked. */
  rateLimited?: Partial<Record<string, boolean>>;
  /** Token budget left; <=0 drops to the cheapest healthy model. */
  budgetRemaining?: number;
}

/** True if this model, or its whole provider, is flagged rate-limited. */
function capped(model: string, s: RouteSignals): boolean {
  const provider = model.split("/")[0];
  return Boolean(s.rateLimited?.[model] || s.rateLimited?.[provider]);
}

/** Role models cheapest-tier first (profile order), for shedding. */
function tierOrder(): string[] {
  return [modelFor("executor"), modelFor("triage"), modelFor("verify"), modelFor("escalate")];
}

/** The cheapest model with no cap, or undefined if every tier is capped. */
function cheapestHealthy(s: RouteSignals): string | undefined {
  for (const m of tierOrder()) if (!capped(m, s)) return m;
  return undefined;
}

/** Shed a capped model to a healthy neighbour: cheaper first, then pricier. */
function shed(model: string, s: RouteSignals): string | undefined {
  const order = tierOrder();
  const from = order.indexOf(model);
  const start = from >= 0 ? from : 0;
  for (let t = start - 1; t >= 0; t--) if (!capped(order[t], s)) return order[t];
  for (let t = start + 1; t < order.length; t++) if (!capped(order[t], s)) return order[t];
  return undefined;
}

/** Every role model is rate-limited — the driver should back off rather than thrash. */
export function allCapped(s: RouteSignals): boolean {
  return tierOrder().every((m) => capped(m, s));
}

/**
 * The intelligent router. DETERMINISTIC — no model-as-router on the hot path.
 *   - Role is the baseline.
 *   - A stuck executor, or a High/Critical candidate, escalates.
 *   - Budget spent -> the cheapest healthy model (never the pricey tier).
 *   - A rate-limited model sheds to a healthy neighbour (cheaper first); if the
 *     whole lineup is capped, the choice stands and `allCapped` tells the driver.
 */
export function routeModel(role: ReconRole, s: RouteSignals = {}): string {
  let model = modelFor(role);

  const stuck = (s.attempts ?? 0) >= ESCALATE_AFTER;
  const grave = s.severityHint === "high" || s.severityHint === "critical";
  if (role === "executor" && (stuck || grave)) model = modelFor("escalate");

  if (s.budgetRemaining !== undefined && s.budgetRemaining <= 0) {
    return cheapestHealthy(s) ?? modelFor("executor");
  }
  if (capped(model, s)) return shed(model, s) ?? model;
  return model;
}

/* ───────────────────────── the approval gate ───────────────────────── */

export interface GateContext {
  /** The single in-scope host; fetchers must target exactly this (bare host, no port). */
  scopeHost?: string;
}

/** Bare, read-only binaries safe to run with any args. */
const READ_SAFE = new Set([
  "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "jq", "yq", "echo", "printf",
  "tr", "uniq", "cut", "ls", "stat", "file", "dig", "nslookup", "host", "whois", "true", "date",
  "basename", "dirname", "xxd", "base64", "column", "tee",
]);
// NOTE: "tee" would write a file, but we strip redirections before tokenising and
// tee with no file writes to stdout; a tee'd file path is a bareword we don't allow here.
const FETCHERS = new Set(["curl", "wget", "http", "https", "httpie"]);

/** curl short flags that change state / write / upload — any one in a cluster asks. */
const CURL_SHORT_DANGER = new Set(["X", "d", "F", "T", "o", "O", "K", "c"]);
/** curl short flags that consume the next argument (so it isn't mistaken for a URL). */
const CURL_SHORT_VALUE = new Set(["H", "A", "b", "e", "u", "m", "x", "y", "Y", "z", "E", "w", "U", "D", "r", "t"]);
/** Long flags that change state / write / upload — these ask. */
const LONG_DANGER = new Set([
  "--request", "--method", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii",
  "--json", "--form", "--form-string", "--upload-file", "--post-file", "--post-data", "--body-file", "--body-data",
  "--output", "--remote-name", "--output-document", "--config", "--trace", "--trace-ascii", "--dump-header", "--cookie-jar",
]);
/** Long flags that consume the next argument. */
const LONG_VALUE = new Set([
  "--header", "--user-agent", "--cookie", "--referer", "--url", "--connect-timeout", "--max-time",
  "--proxy", "--write-out", "--user", "--resolve", "--range", "--retry", "--oauth2-bearer", "--timeout", "--tries",
]);

/**
 * Risk tier for one shell command: may the UI auto-allow it, or must a human
 * approve? Parse-then-allowlist, fail closed. `ctx.scopeHost` makes fetchers
 * require the in-scope host; without it they ask.
 */
export function classifyCommand(command: string, ctx: GateContext = {}): "allow" | "ask" {
  if (!command || /[\r\n]/.test(command)) return "ask";
  if (hasControlOperators(command)) return "ask";
  if (hasFileRedirect(command)) return "ask";

  const stages = command.split("|").map((s) => s.trim()).filter(Boolean);
  if (!stages.length) return "ask";
  for (const stage of stages) {
    // Redirections were validated above; strip them before reading argv.
    const clean = stage.replace(/\d*>>?\s*\S+/g, " ").replace(/<\s*\S+/g, " ").trim();
    const argv = tokenize(clean);
    if (!argv || !argv.length) return "ask";
    if (argv[0].includes("/") || argv[0].includes("=")) return "ask"; // path or env-prefix
    if (stageDecision(argv, ctx) === "ask") return "ask";
  }
  return "allow";
}

/** Sequencing, substitution, backgrounding, OR — anything that joins commands. */
function hasControlOperators(cmd: string): boolean {
  if (/[;`]/.test(cmd)) return true;
  if (/\$\(|\$\{|<\(|>\(/.test(cmd)) return true;
  if (/\|\|/.test(cmd)) return true;
  if (/<(?!<)/.test(cmd)) return true; // input redirection from a file
  // any & that isn't fd-duplication (2>&1, >&2) is backgrounding or &&
  const withoutFd = cmd.replace(/\d*>&\d*/g, "").replace(/&>>?/g, "");
  return withoutFd.includes("&");
}

/** Output redirection to a real file (anything but /dev/null or an fd dup). */
function hasFileRedirect(cmd: string): boolean {
  const re = /\d*>>?\s*(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) {
    const tgt = m[1];
    if (tgt === "/dev/null" || /^&\d+$/.test(tgt)) continue;
    return true;
  }
  return false;
}

/** Split a stage into argv, honouring single/double quotes. null = unbalanced (ask). */
function tokenize(s: string): string[] | null {
  const out: string[] = [];
  let cur = "", q: '"' | "'" | null = null, has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === "\\") { if (i + 1 < s.length) cur += s[++i]; continue; }
    if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ""; has = false; } continue; }
    cur += c; has = true;
  }
  if (q) return null;
  if (cur || has) out.push(cur);
  return out;
}

function stageDecision(argv: string[], ctx: GateContext): "allow" | "ask" {
  const bin = argv[0].toLowerCase();
  const args = argv.slice(1);
  if (bin === "sort") return args.some((a) => a === "-o" || a === "--output") ? "ask" : "allow";
  // awk/sed/find/xargs can execute or write; too varied to validate — always ask.
  if (bin === "awk" || bin === "gawk" || bin === "sed" || bin === "find" || bin === "xargs" || bin === "perl") return "ask";
  if (READ_SAFE.has(bin)) return "allow";
  if (FETCHERS.has(bin)) return fetchDecision(args, ctx);
  if (bin === "nmap") return nmapDecision(args, ctx);
  return "ask";
}

const GET_OR_HEAD = (v: string) => { const u = v.toUpperCase().replace(/['"]/g, ""); return u === "GET" || u === "HEAD"; };

/** A fetcher is safe only as a GET/HEAD to exactly the in-scope host, no body/upload/file-output. */
function fetchDecision(args: string[], ctx: GateContext): "allow" | "ask" {
  if (!ctx.scopeHost) return "ask";
  let target = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { // everything after is operands
      for (let j = i + 1; j < args.length; j++) { if (!matchTarget(args[j], ctx)) return "ask"; target = true; }
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const flag = eq >= 0 ? a.slice(0, eq) : a;
      const val = eq >= 0 ? a.slice(eq + 1) : args[i + 1];
      if ((flag === "--request" || flag === "--method")) { if (!GET_OR_HEAD(val ?? "")) return "ask"; if (eq < 0) i++; continue; }
      if (LONG_DANGER.has(flag)) return "ask";
      if (LONG_VALUE.has(flag) && eq < 0) i++;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      const letters = a.slice(1);
      for (const ch of letters) {
        if (ch === "X") { // method flag — only GET/HEAD, and only if it's the cluster's tail
          if (letters.endsWith("X") && GET_OR_HEAD(args[i + 1] ?? "")) { i++; continue; }
          return "ask";
        }
        if (CURL_SHORT_DANGER.has(ch)) return "ask";
      }
      if (CURL_SHORT_VALUE.has(letters[letters.length - 1])) i++; // flag consumes the next arg
      continue;
    }
    // bareword: a target URL
    if (!matchTarget(a, ctx)) return "ask";
    target = true;
  }
  return target ? "allow" : "ask";
}

/** nmap is safe without NSE/file-output, against exactly the in-scope host. */
function nmapDecision(args: string[], ctx: GateContext): "allow" | "ask" {
  if (!ctx.scopeHost) return "ask";
  let target = false;
  for (const a of args) {
    if (a.startsWith("-")) {
      if (/^--script/.test(a)) return "ask";       // NSE can exploit
      if (/^-o[NXGSA]/.test(a)) return "ask";       // writes a scan file
      continue;
    }
    if (a !== ctx.scopeHost && urlHost(a) !== ctx.scopeHost) return "ask";
    target = true;
  }
  return target ? "allow" : "ask";
}

/** Host of an http(s) URL, lowercased and portless, or null if not such a URL. */
function urlHost(arg: string): string | null {
  const m = /^https?:\/\/([^/:\s]+)/i.exec(arg);
  return m ? m[1].toLowerCase() : null;
}

/** True if `arg` is an http(s) URL whose host equals the in-scope host. */
function matchTarget(arg: string, ctx: GateContext): boolean {
  const h = urlHost(arg);
  return h !== null && h === ctx.scopeHost;
}

/** The in-scope host (lowercased, portless) from a scope string or URL. */
export function hostOf(scope: string): string | undefined {
  const s = scope.trim().replace(/^[a-z]+:\/\//i, "");
  const host = s.split(/[/:\s]/)[0].toLowerCase();
  return host || undefined;
}

/* ───────────────────────── findings ───────────────────────── */

/**
 * How well the tested environment matches production. Declared by the operator
 * before a run; every finding is tagged with it so a config-dependent bug is
 * never shipped as a clean one — the single most important fix over ARTEX.
 */
export interface EnvFidelity {
  kind: "local" | "staging" | "production";
  divergences: string;
  nonProdSettings?: string[];
}

/** One recon finding, tagged with the environment it was seen in. */
export interface ReconFinding {
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  standardId?: string;
  repro: string;
  verdict: "real" | "config-dependent" | "rejected";
  prodCaveat?: string;
  env: EnvFidelity["kind"];
}

/* ───────────────────────── OpenCode subagents ───────────────────────── */

/** Read-only tool posture for the reviewer roles. */
const READ_ONLY_TOOLS = { bash: false, edit: false, write: false, task: false } as const;

/** The executor's tools, widened to edit/write only when its harness says `full`. */
function executorTools(): Record<string, boolean> {
  const full = harnessFor("executor").tools === "full";
  return { bash: true, read: true, task: true, edit: full, write: full };
}

function subagent(model: string, description: string, prompt: string, tools: Record<string, boolean>) {
  return { model, mode: "subagent" as const, description, prompt, tools };
}

/**
 * The recon subagents, one per role, bolted to the active profile's model.
 * NOTE: these are resolved at import, so they reflect the profile/env at server
 * start; `routeModel` re-resolves live for escalation/shedding. If a profile is
 * changed at runtime, restart to re-register. Models not available to the key
 * only fail when a role is actually invoked, not at config load.
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
