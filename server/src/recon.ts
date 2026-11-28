/**
 * Supervised recon / autopwn — the thin slice.
 * -----------------------------------------------------------------------------
 * Adds ARTEX's one genuine edge — an autonomous recon -> hypothesise -> test ->
 * confirm loop — to BugXHunter, without importing ARTEX's failure modes
 * (runaway frontier cost, rate-limit thrash, config-artifact-as-finding).
 *
 * Routing follows a roles x profiles x harness design (the general pattern from
 * the public aider / Claude Code / Roo multi-model research, reimplemented here
 * from scratch for pentest roles). `routeModel` escalates on evidence and sheds
 * a rate-limited model to a healthy neighbour. `EnvFidelity` tags every finding
 * with the environment it was seen in.
 *
 * SECURITY — the approval gate (supervision, not the boundary: see docs/recon-security.md). Two
 * Mythos reviews showed that trying to CLASSIFY arbitrary shell is fail-open:
 * the shell re-parses the string (chaining, substitution, redirection, globbing,
 * $VAR expansion), so predicting what it will run is a losing game. So the gate
 * is now DEFAULT-ASK with a tiny, positively-validated allowlist: a command is
 * auto-allowed only if it contains NO shell metacharacters at all (making it
 * shell-neutral — argv-execution and shell-execution are identical), and every
 * stage is a known binary whose args pass a POSITIVE allowlist. Fetchers are
 * curl GET/HEAD to EXACTLY the in-scope origin (WHATWG host+port, no userinfo,
 * no redirects). Everything else asks and the human reads the real command.
 */

import { readFileSync } from "node:fs";

/** The four jobs in a recon run. Each is bolted to a model by the active profile. */
export type ReconRole = "executor" | "triage" | "verify" | "escalate";

const ROLES: readonly ReconRole[] = ["executor", "triage", "verify", "escalate"];

export type ReconEffort = "low" | "medium" | "high";

/** How a role runs, beyond which model it is. Absent field = today's default. */
export interface ReconHarness {
  budgetTokens?: number;
  maxRounds?: number;
  tools?: "full" | "core";
  effort?: ReconEffort;
  /** The chain pass that follows the main loop (executor role only). Absent field = its default. */
  chainPass?: ChainPassHarness;
}

/**
 * The chain pass: after the main loop, the verified findings are combined into attack
 * paths, each is tried end to end, and the ones that hold are reported with the findings
 * they use. These are its caps; it gets no permission the main loop does not have.
 */
export interface ChainPassHarness {
  enabled?: boolean;
  /** Paths proposed and tried, at most. */
  maxCandidates?: number;
  /** Executor rounds spent demonstrating one path, at most. */
  maxRoundsPerChain?: number;
  /** Share of the token budget the main loop leaves unspent for the pass, in percent. */
  reservePercent?: number;
}

export const CHAIN_PASS_DEFAULTS: Required<ChainPassHarness> = { enabled: true, maxCandidates: 3, maxRoundsPerChain: 3, reservePercent: 15 };
/** Upper bounds: a profile or a request can lower the caps, never lift them past these. */
export const CHAIN_PASS_LIMITS = { maxCandidates: 5, maxRoundsPerChain: 5, reservePercent: 50 } as const;

/** The chain pass settings with the defaults filled in. */
export function resolveChainPass(c?: ChainPassHarness): Required<ChainPassHarness> {
  return { ...CHAIN_PASS_DEFAULTS, ...(c ?? {}) };
}

function parseChainPass(raw: unknown): ChainPassHarness | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const c: ChainPassHarness = {};
  const int = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined);
  if (typeof r.enabled === "boolean") c.enabled = r.enabled;
  const candidates = int(r.maxCandidates, 1, CHAIN_PASS_LIMITS.maxCandidates);
  const rounds = int(r.maxRoundsPerChain, 1, CHAIN_PASS_LIMITS.maxRoundsPerChain);
  const reserve = int(r.reservePercent, 0, CHAIN_PASS_LIMITS.reservePercent);
  if (candidates !== undefined) c.maxCandidates = candidates;
  if (rounds !== undefined) c.maxRoundsPerChain = rounds;
  if (reserve !== undefined) c.reservePercent = reserve;
  return Object.keys(c).length ? c : undefined;
}

/** A profile assigns a model to each role and, optionally, a harness to each. */
export interface ReconProfile {
  models: Record<ReconRole, string>;
  harness?: Partial<Record<ReconRole, ReconHarness>>;
}

/** Built-in profiles, cheap -> capable (authored cheapest-role-first so shedding
 *  and budget fallback pick the cheapest). `scx/*` is open-weight, `anthropic/*`
 *  is Claude. `recon-open` works with no Anthropic key. */
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
    models: { executor: "anthropic/claude-haiku-5-5", triage: "anthropic/claude-haiku-5-5", verify: "anthropic/claude-sonnet-5-5", escalate: "anthropic/claude-mythos-5-2" },
    harness: {
      executor: { tools: "core", maxRounds: 50, budgetTokens: 2_000_000, effort: "high" },
      triage: { tools: "core" }, verify: { tools: "core", effort: "high" }, escalate: { tools: "core", effort: "high" },
    },
  },
};

export const DEFAULT_PROFILE = "recon-balanced";

export function parseReconHarness(raw: unknown): ReconHarness | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const h: ReconHarness = {};
  if (typeof r.budgetTokens === "number" && Number.isInteger(r.budgetTokens) && r.budgetTokens >= 1) h.budgetTokens = r.budgetTokens;
  if (typeof r.maxRounds === "number" && Number.isInteger(r.maxRounds) && r.maxRounds >= 1) h.maxRounds = r.maxRounds;
  if (r.tools === "full" || r.tools === "core") h.tools = r.tools;
  if (r.effort === "low" || r.effort === "medium" || r.effort === "high") h.effort = r.effort;
  const chainPass = parseChainPass(r.chainPass);
  if (chainPass) h.chainPass = chainPass;
  return Object.keys(h).length ? h : undefined;
}

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
  } catch { /* no file / bad json -> built-ins only */ }
  return merged;
}

/** The profile used when RECON_PROFILE is unset and no Anthropic key is configured. */
export const OPEN_PROFILE = "recon-open";

let anthropicAvailable = true;
/**
 * Tell the router whether Claude can be called at all. Without an Anthropic key
 * the default profile (which puts triage/verify/escalate on Claude) cannot run,
 * so the default becomes the open-weight profile. An explicit RECON_PROFILE or a
 * per-role RECON_*_MODEL still wins: the operator asked for it.
 */
export function setAnthropicAvailable(available: boolean): void { anthropicAvailable = available; }

export function activeProfileName(): string {
  return (process.env.RECON_PROFILE || "").trim() || (anthropicAvailable ? DEFAULT_PROFILE : OPEN_PROFILE);
}

export function activeProfile(): ReconProfile {
  const profiles = loadProfiles();
  const name = activeProfileName();
  return Object.hasOwn(profiles, name) ? profiles[name] : BUILTIN_PROFILES[DEFAULT_PROFILE];
}

export function profileNames(): string[] {
  return Object.keys(loadProfiles());
}

const ROLE_ENV: Record<ReconRole, string> = {
  executor: "RECON_EXECUTOR_MODEL", triage: "RECON_TRIAGE_MODEL",
  verify: "RECON_VERIFY_MODEL", escalate: "RECON_ESCALATE_MODEL",
};

export function modelFor(role: ReconRole): string {
  return (process.env[ROLE_ENV[role]] || "").trim() || activeProfile().models[role];
}

export function harnessFor(role: ReconRole): ReconHarness {
  return activeProfile().harness?.[role] ?? {};
}

const ESCALATE_AFTER_VALUE = (() => {
  const n = Number(process.env.RECON_ESCALATE_AFTER);
  return Number.isInteger(n) && n >= 1 ? n : 2;
})();
/** Stuck attempts before the executor earns a stronger model (validated env). */
export function escalateAfter(): number { return ESCALATE_AFTER_VALUE; }

export interface RouteSignals {
  attempts?: number;
  /** Severity of the CURRENT candidate (not accumulated — escalation is one-shot). */
  severityHint?: "low" | "medium" | "high" | "critical";
  rateLimited?: Partial<Record<string, boolean>>;
  budgetRemaining?: number;
}

function capped(model: string, s: RouteSignals): boolean {
  const provider = model.split("/")[0];
  return Boolean(s.rateLimited?.[model] || s.rateLimited?.[provider]);
}

/** The four role models, cheapest role first (executor, triage, verify, escalate). */
export function tierOrder(): string[] {
  return [modelFor("executor"), modelFor("triage"), modelFor("verify"), modelFor("escalate")];
}

function cheapestHealthy(s: RouteSignals): string | undefined {
  for (const m of tierOrder()) if (!capped(m, s)) return m;
  return undefined;
}

function shed(model: string, s: RouteSignals): string | undefined {
  const order = tierOrder();
  const from = order.indexOf(model);
  const start = from >= 0 ? from : 0;
  for (let t = start - 1; t >= 0; t--) if (!capped(order[t], s)) return order[t];
  for (let t = start + 1; t < order.length; t++) if (!capped(order[t], s)) return order[t];
  return undefined;
}

export function allCapped(s: RouteSignals): boolean {
  return tierOrder().every((m) => capped(m, s));
}

/** Deterministic router: role baseline; escalate on evidence; budget-spent ->
 *  cheapest healthy; rate-limited -> healthy neighbour (cheaper first). */
export function routeModel(role: ReconRole, s: RouteSignals = {}): string {
  let model = modelFor(role);
  const stuck = (s.attempts ?? 0) >= ESCALATE_AFTER_VALUE;
  const grave = s.severityHint === "high" || s.severityHint === "critical";
  if (role === "executor" && (stuck || grave)) model = modelFor("escalate");
  if (s.budgetRemaining !== undefined && s.budgetRemaining <= 0) return cheapestHealthy(s) ?? modelFor("executor");
  if (capped(model, s)) return shed(model, s) ?? model;
  return model;
}

/* ═══════════════════════ the approval gate ═══════════════════════ */

export interface GateContext {
  /** In-scope host (lowercase, no port). */
  scopeHost?: string;
  /** In-scope port as a string ("8765", "80", "443"). */
  scopePort?: string;
  /** The run's captured-session cookie jar (a path relative to the project): the one file `curl -b` may name. */
  cookieFile?: string;
  /** The run's captured-session header file: the one file `curl -H @…` may name. */
  headerFile?: string;
}

/**
 * One read filter's POSITIVE allowlist. A flag that is not listed asks — the
 * same rule curl gets — because "read-only" filters have flags that execute
 * (`rg --pre`, `sort --compress-program`), write (`sort -o`) or read local files
 * (`grep -f`, `grep -r`, `jq --rawfile`). Operands are capped at what the filter
 * needs to read stdin (a pattern, a jq program, tr's sets), so no file operand fits.
 */
interface FilterSpec {
  /** Single-letter flags that take no value (may be clustered: -in). */
  short: string;
  /** Single-letter flags that take a value, attached (-d:) or as the next arg. */
  shortVal: string;
  /** Long flags accepted exactly as written (no value). */
  long: readonly string[];
  /** Long flags that take a value (--flag=value or --flag value). */
  longVal: readonly string[];
  /** Most positional operands allowed. */
  operands: number;
  /** Accept -NUM (head -50, grep -3). */
  numeric?: boolean;
  /** Flags that supply the pattern, leaving no room for a positional one. */
  patternFlags?: readonly string[];
}

const COLOR = ["--color=never", "--color=always", "--color=auto", "--colour=never", "--colour=always", "--colour=auto"];
const GREP: FilterSpec = {
  short: "ivcnowxEFPhHqsab", shortVal: "emABC", numeric: true, operands: 1, patternFlags: ["-e", "--regexp"],
  long: ["--ignore-case", "--invert-match", "--count", "--line-number", "--only-matching", "--word-regexp", "--line-regexp",
    "--extended-regexp", "--fixed-strings", "--perl-regexp", "--no-filename", "--quiet", "--silent", "--text", "--byte-offset", ...COLOR],
  longVal: ["--regexp", "--max-count", "--after-context", "--before-context", "--context"],
};
const HEAD: FilterSpec = {
  short: "qv", shortVal: "nc", numeric: true, operands: 0,
  long: ["--quiet", "--silent", "--verbose"], longVal: ["--lines", "--bytes"],
};
const FILTERS: Record<string, FilterSpec> = {
  grep: GREP, egrep: GREP, fgrep: GREP,
  rg: { // no --pre, -f, -g, -z, -L
    short: "iSsvcnNowxFPqa", shortVal: "emABC", operands: 1, patternFlags: ["-e", "--regexp"],
    long: ["--ignore-case", "--smart-case", "--case-sensitive", "--invert-match", "--count", "--line-number", "--no-line-number",
      "--only-matching", "--word-regexp", "--line-regexp", "--fixed-strings", "--pcre2", "--quiet", "--text", ...COLOR],
    longVal: ["--regexp", "--max-count", "--after-context", "--before-context", "--context"],
  },
  head: HEAD,
  tail: HEAD, // no -f/--follow/--pid
  cut: {
    short: "sz", shortVal: "dfcb", operands: 0,
    long: ["--only-delimited", "--complement", "--zero-terminated"],
    longVal: ["--delimiter", "--fields", "--characters", "--bytes", "--output-delimiter"],
  },
  sort: { // no -o/--output, -T, -S, --compress-program, --files0-from, --random-source, -m
    short: "bdfghinMRrVus", shortVal: "kt", operands: 0,
    long: ["--ignore-leading-blanks", "--dictionary-order", "--ignore-case", "--general-numeric-sort", "--human-numeric-sort",
      "--ignore-nonprinting", "--month-sort", "--numeric-sort", "--random-sort", "--reverse", "--version-sort", "--unique", "--stable"],
    longVal: ["--key", "--field-separator"],
  },
  uniq: {
    short: "cduiD", shortVal: "fsw", operands: 0,
    long: ["--count", "--repeated", "--unique", "--ignore-case"],
    longVal: ["--skip-fields", "--skip-chars", "--check-chars"],
  },
  wc: { // no --files0-from
    short: "lwcmL", shortVal: "", operands: 0,
    long: ["--lines", "--words", "--bytes", "--chars", "--max-line-length"], longVal: [],
  },
  column: {
    short: "tx", shortVal: "soc", operands: 0,
    long: ["--table", "--fillrows"], longVal: ["--separator", "--output-separator", "--output-width"],
  },
  tr: {
    short: "dscCt", shortVal: "", operands: 2,
    long: ["--delete", "--squeeze-repeats", "--complement", "--truncate-set1"], longVal: [],
  },
  jq: { // no -f/--from-file, -L, --rawfile, --slurpfile, --arg*, --args
    short: "rceMSajsnC", shortVal: "", operands: 1,
    long: ["--raw-output", "--compact-output", "--exit-status", "--monochrome-output", "--sort-keys", "--ascii-output",
      "--join-output", "--slurp", "--null-input", "--color-output", "--tab"],
    longVal: ["--indent"],
  },
};
/** jq program words that read the environment, name input files or load modules. */
const JQ_UNSAFE = /\b(?:env|input_filename|import|include)\b/;
/** nmap flags we are confident do not exploit or write. */
const NMAP_SAFE = new Set(["-sv", "-st", "-pn", "-n", "-v", "-vv", "--open", "-6"]);
/** curl flags that take no value and neither write, reroute, nor change method. */
const CURL_SAFE_NOVAL = new Set([
  "-s", "-S", "-i", "-I", "-k", "-f", "-g", "-q", "-#", "-v", "-6", "-4",
  "--silent", "--show-error", "--include", "--head", "--insecure", "--fail", "--globoff",
  "--compressed", "--http1.1", "--http1.0", "--http2", "--no-progress-meter", "--verbose", "--ipv4", "--ipv6",
]);
/** curl flags that take one value, where the value can't reroute or read a file. */
const CURL_SAFE_VAL = new Set([
  "-H", "--header", "-A", "--user-agent", "-e", "--referer", "-m", "--max-time", "--connect-timeout",
  "-b", "--cookie", "--retry", "--retry-delay",
]);
/** single-letter curl flags inside those value-taking long/short names, for clusters. */
const CURL_SAFE_NOVAL_LETTERS = new Set([..."sSiIkfgq#v64"]);

/**
 * Risk tier for one shell command. DEFAULT-ASK: a command is auto-allowed only
 * if it is shell-neutral (no metacharacters) AND every stage positively validates.
 */
export function classifyCommand(command: string, ctx: GateContext = {}): "allow" | "ask" {
  if (!command) return "ask";
  // Shell metacharacters make a string's effect shell-dependent and unpredictable.
  // Reject them all: the allowed subset then runs identically via argv or a shell.
  // (`|` is handled by splitting into stages; `||` leaves an empty stage -> ask.)
  if (/[\r\n\\$`;&<>(){}[\]*?!~]/.test(command)) return "ask";
  if (command.includes("||")) return "ask";

  const stages = command.split("|").map((s) => s.trim()).filter(Boolean);
  if (!stages.length) return "ask";
  for (let i = 0; i < stages.length; i++) {
    const argv = tokenize(stages[i]);
    if (!argv || !argv.length) return "ask";
    if (stageAllow(argv, i === 0, ctx) === "ask") return "ask";
  }
  return "allow";
}

/** Split a stage into argv, honouring single/double quotes. null = unbalanced (ask). */
function tokenize(s: string): string[] | null {
  const out: string[] = [];
  let cur = "", q: '"' | "'" | null = null, has = false;
  for (const c of s) {
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ""; has = false; } continue; }
    cur += c; has = true;
  }
  if (q) return null;
  if (cur || has) out.push(cur);
  return out;
}

function stageAllow(argv: string[], isFirst: boolean, ctx: GateContext): "allow" | "ask" {
  const bin = argv[0].toLowerCase();
  if (bin.includes("/") || bin.includes("=")) return "ask"; // path or env-prefix
  const args = argv.slice(1);
  if (bin === "curl") return isFirst ? curlAllow(args, ctx) : "ask"; // a fetch is a source, never downstream
  if (bin === "nmap") return isFirst ? nmapAllow(args, ctx) : "ask";
  // Filters auto-allow ONLY downstream of a source (reading piped stdin), never as
  // a first stage (which would read a file) — so file reads are never auto-allowed.
  if (Object.hasOwn(FILTERS, bin)) return isFirst ? "ask" : filterAllow(bin, args);
  return "ask";
}

/** curl is safe only as a GET/HEAD to exactly the in-scope origin, via a positive
 *  flag allowlist (unknown flag -> ask), no redirects, no file read/write. */
function curlAllow(args: string[], ctx: GateContext): "allow" | "ask" {
  if (!ctx.scopeHost) return "ask";
  // -v prints the request headers: with the captured session that would put its values in the transcript.
  const usesSession = args.some((a) => (ctx.cookieFile && a === ctx.cookieFile) || (ctx.headerFile && a === `@${ctx.headerFile}`)
    || (ctx.cookieFile && a === `--cookie=${ctx.cookieFile}`) || (ctx.headerFile && a === `--header=@${ctx.headerFile}`));
  if (usesSession && args.some((a) => a === "--verbose" || (/^-[A-Za-z0-9#]+$/.test(a) && a.includes("v")))) return "ask";
  let url = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-X" || a === "--request") {
      const v = (args[++i] ?? "").toUpperCase();
      if (v !== "GET" && v !== "HEAD") return "ask";
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const flag = eq >= 0 ? a.slice(0, eq) : a;
      if (CURL_SAFE_NOVAL.has(flag)) continue;
      if (CURL_SAFE_VAL.has(flag)) {
        const v = eq >= 0 ? a.slice(eq + 1) : args[++i];
        if (v === undefined) return "ask";
        if (flag === "--header" && v.startsWith("@") && !isSessionFile(v.slice(1), ctx.headerFile)) return "ask"; // @file read
        if (flag === "--cookie" && !v.includes("=") && !isSessionFile(v, ctx.cookieFile)) return "ask";  // no "=" -> curl reads it as a cookie FILE
        continue;
      }
      return "ask";
    }
    if (a.startsWith("-") && a.length > 1) {
      if (CURL_SAFE_NOVAL.has(a)) continue;
      if (CURL_SAFE_VAL.has(a)) {
        const v = args[++i];
        if (v === undefined) return "ask";
        if (a === "-H" && v.startsWith("@") && !isSessionFile(v.slice(1), ctx.headerFile)) return "ask";
        if (a === "-b" && !v.includes("=") && !isSessionFile(v, ctx.cookieFile)) return "ask"; // no "=" -> a cookie FILE
        continue;
      }
      // a cluster of safe no-value single flags, e.g. -sS, -sI
      if ([...a.slice(1)].every((c) => CURL_SAFE_NOVAL_LETTERS.has(c))) continue;
      return "ask";
    }
    if (!okUrl(a, ctx)) return "ask";
    url = true;
  }
  return url ? "allow" : "ask";
}

/**
 * The one file a run's curl may read: the captured session the runner wrote for it, named
 * exactly as the runner named it (no other spelling of the path). The URL check still
 * applies, so the session only ever goes to the in-scope origin.
 */
function isSessionFile(arg: string, allowed?: string): boolean {
  return Boolean(allowed) && arg === allowed;
}

/** True if `arg` is an http(s) URL for exactly the in-scope origin, no userinfo. */
function okUrl(arg: string, ctx: GateContext): boolean {
  let u: URL;
  try { u = new URL(arg); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false; // userinfo would reroute the real connection
  if (u.hostname.toLowerCase() !== ctx.scopeHost) return false;
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  if (ctx.scopePort && port !== ctx.scopePort) return false;
  return true;
}

/** A read filter on piped stdin: every flag on its positive allowlist, and no
 *  more operands than it needs to read stdin (so none can name a file). */
function filterAllow(bin: string, args: string[]): "allow" | "ask" {
  const spec = FILTERS[bin];
  let operands = 0, max = spec.operands;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-") || a === "-") {
      if (bin === "jq" && JQ_UNSAFE.test(a)) return "ask";
      operands++;
      continue;
    }
    if (a.startsWith("--")) {
      if (spec.long.includes(a)) continue;
      const eq = a.indexOf("=");
      const flag = eq >= 0 ? a.slice(0, eq) : a;
      if (!spec.longVal.includes(flag)) return "ask"; // unknown flag (and a bare "--")
      if (eq < 0 && args[++i] === undefined) return "ask";
      if (spec.patternFlags?.includes(flag)) max = 0;
      continue;
    }
    if (spec.numeric && /^-\d+$/.test(a)) continue;
    // a cluster of no-value letters, optionally ending in one value-taking letter
    for (let j = 1; j < a.length; j++) {
      const c = a[j];
      if (spec.short.includes(c)) continue;
      if (!spec.shortVal.includes(c)) return "ask";
      if (j === a.length - 1 && args[++i] === undefined) return "ask"; // the value is the next arg
      if (spec.patternFlags?.includes("-" + c)) max = 0;
      break; // the rest of the cluster (or the next arg) is this flag's value
    }
  }
  return operands <= max ? "allow" : "ask";
}

/** nmap is safe without NSE / file output / aggressive scripts, against the in-scope host. */
function nmapAllow(args: string[], ctx: GateContext): "allow" | "ask" {
  if (!ctx.scopeHost) return "ask";
  let target = false;
  for (const a of args) {
    if (a.startsWith("-")) {
      const low = a.toLowerCase();
      if (NMAP_SAFE.has(low)) continue;
      if (/^-p[\d,\-]+$/i.test(a)) continue; // -p80,443
      if (/^-t[0-5]$/i.test(a)) continue;    // -T4
      return "ask"; // -sC/-A/--script/-sS/-o*/single-dash-long/etc.
    }
    if (a.toLowerCase() !== ctx.scopeHost) return "ask";
    target = true;
  }
  return target ? "allow" : "ask";
}

/** The in-scope host (lowercase, portless) from a scope string or URL. */
export function hostOf(scope: string): string | undefined {
  return originOf(scope).host;
}

/** The in-scope origin (host + normalized port) from a scope string or URL. */
export function originOf(scope: string): { host?: string; port?: string } {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(scope) ? scope : `http://${scope}`);
    return { host: u.hostname.toLowerCase(), port: u.port || (u.protocol === "https:" ? "443" : "80") };
  } catch {
    return {};
  }
}

/* ─────────────── the denylist floor (hard-deny shapes) ─────────────── */

/** Leading tokens that wrap another command; peeled so the real command shows. */
const WRAPPERS = new Set(["sudo", "doas", "nice", "ionice", "nohup", "setsid", "stdbuf", "command", "builtin", "exec", "eval", "time", "caffeinate", "xargs"]);

/**
 * Peel wrapper / `env VAR=…` / `sh -c "…"` layers and return every effective
 * command string to scan — so intent hidden inside `sudo env X=1 bash -c "rm -rf /"`
 * is unwrapped before matching. (Structural normalisation, the technique from the
 * public codex / tc-cli safety scanners; reimplemented here.)
 */
export function effectiveCommands(cmd: string, depth = 0): string[] {
  if (depth > 6 || !cmd) return [cmd];
  const out: string[] = [];
  let words = tokenize(cmd) ?? cmd.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++; // leading VAR=val
  if (words[i] === "env") { i++; while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++; }
  words = words.slice(i);
  while (words.length > 1 && WRAPPERS.has(words[0])) {
    const w = words[0];
    words = words.slice(1);
    if (w === "timeout" || w === "nice" || w === "ionice" || w === "xargs") {
      while (words.length > 1 && /^[-\d]/.test(words[0])) words = words.slice(1);
    }
  }
  out.push(words.join(" "));
  if (/^(?:ba|z|k|da)?sh$/.test(words[0] ?? "")) {
    const m = /\s-[a-z]*c\b\s+(['"])([\s\S]*?)\1/.exec(cmd); // sh -c "<inner>"
    if (m) for (const inner of effectiveCommands(m[2], depth + 1)) out.push(inner);
  }
  return out;
}

function isRmRf(c: string): boolean {
  if (!/(^|[\s;&|])rm(\s|$)/.test(c)) return false;
  return (/\s-\w*[rR]/.test(c) && /\s-\w*f/.test(c)) || (/--recursive/.test(c) && /--force/.test(c)) || /--no-preserve-root/.test(c);
}

/**
 * Hard-deny shapes for a SUPERVISED pentest — returns a reason or null. Re-scoped
 * from a coding agent's denylist: these are things the agent would run on ITS OWN
 * host (wreck the box) or that turn the agent into a victim/zombie (download->shell,
 * reverse shell, secret exfil). They are NOT in-scope attacks on the target (a
 * `curl -X DELETE http://target/x` is the job and is handled by the allow/ask tier),
 * so denying them never blocks legitimate testing.
 */
export function commandHazard(command: string): string | null {
  for (const c of effectiveCommands(command)) {
    // Agent-host catastrophic
    if (isRmRf(c) && /(^|\s)(\/|~|\$HOME|\/\*|\*|~\/\*?)(\s|$)/.test(c)) return "recursive force-delete of a root/home/unqualified target";
    if (/(^|[\s;&|])mkfs(\.\w+)?\b/.test(c)) return "filesystem format (mkfs)";
    if (/\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|hd|vd|mmcblk|disk|xvd)/.test(c)) return "dd over a raw block device";
    if (/>\s*\/dev\/(?:sd|nvme|hd|vd|mmcblk|disk|xvd)/.test(c)) return "redirect over a raw block device";
    if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(c)) return "fork bomb";
    if (/\bchmod\b\s+(?:-\w*R\w*\s+)?0*777\s+\/(?:\s|$)/.test(c)) return "world-writable chmod of the filesystem root";
    // Agent-compromise: the agent itself turned into a victim/zombie (never a legit test of the target)
    if (/\b(?:curl|wget|fetch)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/.test(c)) return "piping a download straight into a shell (agent RCE)";
    if (/\bbase64\b\s+(?:-d|--decode)\b[^\n|]*\|\s*(?:ba|z|k)?sh\b/.test(c)) return "decoding base64 straight into a shell";
    if (/\/dev\/(?:tcp|udp)\//.test(c)) return "raw socket via /dev/tcp (reverse shell from the agent)";
    if (/\bnc\b[^\n]*\s-\w*e\b/.test(c)) return "netcat -e (reverse shell from the agent)";
    if (/\b(?:ba|z|k)?sh\b\s+-\w*i\w*\b[^\n]*(?:>&|>|2>&1)/.test(c) && /\/dev\/tcp|\d{1,3}(?:\.\d{1,3}){3}/.test(c)) return "interactive shell redirected to a socket (reverse shell)";
  }
  return null;
}

/* ─────────────── env hygiene ─────────────── */

/** Operator / provider secrets that must never reach the executor's subprocess env,
 *  so a prompt-injected agent (fed adversarial target output) has nothing to exfil. */
export const SENSITIVE_ENV = [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_WEB_IDENTITY_TOKEN_FILE", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SCX_API", "SCX_API_KEY", "OPENROUTER_API_KEY", "NVIDIA_API_KEY",
  "AZURE_CLIENT_SECRET", "GCP_SERVICE_ACCOUNT", "OPEN_RUNNER_SECRET", "GITHUB_CLIENT_SECRET", "TURNSTILE_SECRET_KEY",
];

/** A copy of `env` with the operator's secrets stripped — the structural anti-exfil
 *  control (the real boundary in Monitor mode, since egress is logged, not blocked).
 *  Removes the named keys plus anything matching a secret-shaped suffix. */
export function scrubEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of Object.keys(out)) {
    if (SENSITIVE_ENV.includes(k) || /(?:_TOKEN|_SECRET|_API_?KEY|_PASSWORD|_CREDENTIALS?|_PRIVATE_KEY)$/i.test(k)) delete out[k];
  }
  return out;
}

/**
 * Run `fn` with the operator's secrets temporarily removed from `process.env`,
 * then restore it. The OpenCode SDK spawns the agent with a synchronous
 * `{...process.env}` snapshot, so wrapping that spawn in this helper gives the
 * agent (and its shell) a scrubbed env while the runner keeps its own secrets.
 * The scrub window is exactly the synchronous body of `fn` — no async gap.
 */
export function withScrubbedEnv<T>(fn: () => T): T {
  const kept = scrubEnv(process.env);
  const removed: Record<string, string> = {};
  for (const k of Object.keys(process.env)) {
    const v = process.env[k];
    if (!(k in kept) && v !== undefined) { removed[k] = v; delete process.env[k]; }
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(removed)) process.env[k] = v;
  }
}

/* ═══════════════════════ findings ═══════════════════════ */

/**
 * How well the tested environment matches production — every finding is tagged
 * with it so a config-dependent bug is never shipped as a clean one.
 */
export interface EnvFidelity {
  kind: "local" | "staging" | "production";
  divergences: string;
  nonProdSettings?: string[];
}

export interface ReconFinding {
  /** "F1", "F2", …: given when the run keeps the finding, so an attack path can name it. */
  id?: string;
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  standardId?: string;
  repro: string;
  verdict: "real" | "config-dependent" | "rejected";
  prodCaveat?: string;
  env: EnvFidelity["kind"];
  /** Excerpts of the response the verifier quoted as proof. */
  quotes?: string[];
  /**
   * How those quotes fared against what this run's commands really returned (recon-evidence.ts):
   * `quoted` (all found), `unmatched` (one was not: paraphrased or made up), `unquoted` (none given).
   * Absent on a finding from before quotes were checked.
   */
  proof?: "quoted" | "unmatched" | "unquoted";
}

/**
 * A captured logged-in session, written into the project folder for one run. The run is
 * given the file names, never the values.
 */
export interface ReconSessionUse {
  /** The cookie jar, relative to the project folder; absent when the session has no cookies. */
  cookieFile?: string;
  /** The header file (the Authorization header); absent when none was captured. */
  headerFile?: string;
  capturedAt: number;
  cookies: number;
  authorization: boolean;
  /** Removes the files. Called when the run ends. */
  cleanup: () => void;
}

/** A finding an earlier run on the same target verified, as the next run is told about it. */
export interface PriorFinding {
  title: string;
  severity: ReconFinding["severity"];
  verdict: "real" | "config-dependent";
  standardId?: string;
  repro: string;
  env: EnvFidelity["kind"];
  /** When the newest run that verified it finished (ms). */
  seen: number;
  /** How many earlier runs verified it. */
  runs: number;
}

/** An attack path an earlier run recorded. */
export interface PriorPath {
  title: string;
  severity: ReconFinding["severity"];
  status: "demonstrated" | "partial";
  impact: string;
  steps: string[];
  seen: number;
}

/** What earlier runs on a target left behind: where the next run starts from. */
export interface ReconRecall {
  runs: number;
  lastRun: number;
  findings: PriorFinding[];
  paths: PriorPath[];
  /** Leads the newest run left open: noticed, never followed. */
  leads?: string[];
}

/**
 * Something the executor noticed and did not get to: an id, a hidden parameter, an error
 * that leaks something. The run keeps the list, so a lead is followed or closed rather
 * than forgotten when the conversation moves on.
 */
export interface ReconLead {
  /** "L1", "L2", …: how the executor names it when it closes it. */
  id: string;
  text: string;
  status: "open" | "closed";
  /** What came of it, in the executor's words, once closed. */
  outcome?: string;
  /** The round of the main loop it was noted in. */
  round: number;
}

/**
 * The outcome of re-checking one finding an earlier run verified. The verifier rules;
 * the code keeps "fixed" and "still-reproducible" only when the ruling carries evidence.
 */
export interface ReconRetest {
  title: string;
  severity: ReconFinding["severity"];
  standardId?: string;
  result: "still-reproducible" | "fixed" | "cannot-confirm";
  /** The request or command and the response now. */
  evidence?: string;
  /** One line on why. */
  note?: string;
  /** When the finding was last verified before this retest (ms). */
  lastVerified: number;
  /** How the ruling's quotes fared against this run's real output. */
  proof?: "quoted" | "unmatched" | "unquoted";
}

/**
 * The outcome of re-checking one finding an earlier run verified. The verifier rules;
 * the code keeps "fixed" and "still-reproducible" only when the ruling carries evidence.
 */
export interface ReconRetest {
  title: string;
  severity: ReconFinding["severity"];
  standardId?: string;
  result: "still-reproducible" | "fixed" | "cannot-confirm";
  /** The request or command and the response now. */
  evidence?: string;
  /** One line on why. */
  note?: string;
  /** When the finding was last verified before this retest (ms). */
  lastVerified: number;
  /** How the ruling's quotes fared against this run's real output. */
  proof?: "quoted" | "unmatched" | "unquoted";
}

/** One step of an attack path: what was done, and the request and response that show it. */
export interface ReconChainStep {
  action: string;
  evidence?: string;
}

/**
 * An attack path the chain pass proposed, before anything was run: findings of this run
 * (and what was seen along the way) put in an order that would reach `goal`.
 */
export interface ChainCandidate {
  title: string;
  goal: string;
  /** Ids of the findings it builds on. Every one exists in the run. */
  links: string[];
  steps: string[];
  /** The step (from 1) the proposer could not vouch for, if it named one. */
  unproven?: number;
}

/**
 * An attack path the verifier looked at. `demonstrated`: every step has its evidence.
 * `partial`: it stopped at `blockedAt`, and is a lead, never a finding.
 */
export interface ReconChain {
  /** "P1", "P2", …: given when the run keeps the path. */
  id?: string;
  title: string;
  /** For a demonstrated path, never below the worst finding it uses. */
  severity: ReconFinding["severity"];
  /** Config-dependent when the verifier says so, or when any finding it uses is. */
  verdict: "real" | "config-dependent";
  standardId?: string;
  /** What an attacker ends up with. */
  impact: string;
  links: string[];
  steps: ReconChainStep[];
  status: "demonstrated" | "partial";
  /** The step (from 1) a partial path stopped at, and why. */
  blockedAt?: number;
  blockedWhy?: string;
  prodCaveat?: string;
  env: EnvFidelity["kind"];
}

/* ═══════════════════════ OpenCode subagents ═══════════════════════ */

type Rule = "allow" | "ask" | "deny";

/**
 * Permission rules, not the older `tools` map: OpenCode turns `tools: { bash: true }`
 * into a trailing `bash: allow` rule that outranks the global `bash: ask`, so the
 * executor's shell would run with no approval and the gate would never be asked.
 *
 * Reviewer roles are read-only, and nothing in a recon run may reach out through
 * webfetch or websearch: they read untrusted target output.
 */
const READ_ONLY: Record<string, Rule> = { bash: "deny", edit: "deny", task: "deny", webfetch: "deny", websearch: "deny" };

/** The executor: every shell command asks (the gate answers), file edits only in a "full" harness. */
function executorPermission(): Record<string, Rule> {
  const full = harnessFor("executor").tools === "full";
  return { bash: "ask", edit: full ? "ask" : "deny", task: "allow", webfetch: "deny", websearch: "deny" };
}

function subagent(model: string, description: string, prompt: string, permission: Record<string, Rule>, mode: "subagent" | "all" = "subagent") {
  return { model, mode, description, prompt, permission };
}

/** The line the executor ends every turn with; the driver reads it (parseTurnStatus). */
export const STATUS_LINE = "RECON-STATUS";
const STATUS_RULE = `End every turn with exactly one final line: "${STATUS_LINE}: continue" (there is more in-scope surface to test), "${STATUS_LINE}: stuck" (the current thread is blocked and you need help), or "${STATUS_LINE}: done" (the in-scope surface is exhausted).`;

/**
 * The recon agents for OpenCode's config, resolved when called (the profile and
 * env at that moment); `routeModel` re-resolves live for escalation/shedding.
 * Restart to re-register after a profile change. The executor is mode "all": the
 * driver prompts it directly, and it stays callable as a subagent.
 */
export const reconAgents = () => ({
  recon: subagent(
    modelFor("executor"),
    "Supervised recon/autopwn executor: enumerate the in-scope target, hypothesise weaknesses, test them with low-impact probes, and hand candidates to recon-verify. Read-only shell; never mutates state without an approved step.",
    "You are the EXECUTOR in a supervised penetration test of a single, explicitly in-scope target. Work one hypothesis at a time: enumerate -> hypothesise a specific weakness (name the OWASP/API Top 10 or WSTG id) -> test it with the smallest, lowest-impact probe that settles it -> record exactly what you observed. Prefer read-only probes (GET, HEAD, nmap -sV, DNS, reading saved responses). Anything that changes state (POST that writes, PUT, PATCH, DELETE, file writes) is a RED LINE: stop and hand it to the human for approval, with the one request you want to run and why. When you believe you have a finding, call the recon-verify subagent with the evidence — do NOT promote it yourself. Stay strictly inside the declared scope. If you are stuck after a couple of tries, say so plainly rather than widening scope. " + STATUS_RULE,
    executorPermission(),
    "all",
  ),
  "recon-triage": subagent(
    modelFor("triage"),
    "Fast, cheap triage of tool output: is this response interesting, already seen, or noise? Returns a one-line verdict and the single most promising next direction.",
    "You triage raw tool output for the executor. In two or three sentences: is there anything security-relevant here, have we effectively seen it already, and what is the single most promising next probe? Do not run tools or speculate beyond the output you were given.",
    READ_ONLY,
  ),
  "recon-verify": subagent(
    modelFor("verify"),
    "Adversarially verifies one candidate finding, one attack path that builds on findings, or one retest of an earlier finding, against the declared environment and the standards catalogue, assigns severity, and flags config-dependent findings before they are promoted.",
    "You VERIFY one candidate finding. Reject it unless there is concrete reproduction evidence (the request/command and the response that proves it). Assign severity with the project's rubric and cite the matching OWASP/API/WSTG id. CRITICAL: compare the finding against the declared environment fidelity — if it depends on a setting that differs from production (an auth flag off, a debug mode on, seed data), mark it config-dependent and say exactly what to re-test against production. Output exactly one fenced json block and nothing after it: {\"title\": \"short name of the finding\", \"verdict\": \"real\" | \"config-dependent\" | \"rejected\", \"severity\": \"low\" | \"medium\" | \"high\" | \"critical\", \"standard_id\": \"e.g. API1:2023\", \"repro\": \"the request or command and the response that proves it\", \"quotes\": [\"one to three short excerpts of the response that prove it, copied character for character\"], \"prod_caveat\": \"what to re-test against production, or an empty string\"}. The quotes are checked by the program against what the commands of this run really returned, so copy them exactly from the response you were shown, never from memory or from a summary, and give an empty list if you were not shown the response itself. When you are handed an ATTACK PATH (several steps that build on findings named F1, F2 and so on) instead of one finding, rule on the path as a whole. Reject it unless every step has its own request or command and response, and the evidence shows that what one step returned was used in the next: steps that each work but do not connect are not a path. A path that stops at a step that could not be shown is partial, never demonstrated. Rate severity on what the attacker ends up with, and apply the same environment check. For a path, output the block in this form instead: {\"kind\": \"chain\", \"title\": \"short name of the path\", \"verdict\": \"real\" | \"config-dependent\" | \"rejected\", \"severity\": \"low\" | \"medium\" | \"high\" | \"critical\", \"standard_id\": \"e.g. API1:2023\", \"impact\": \"what the attacker ends up with\", \"links\": [\"F1\", \"F3\"], \"steps\": [{\"action\": \"what was done\", \"evidence\": \"the request or command and the response\"}], \"status\": \"demonstrated\" | \"partial\", \"blocked_at\": the number of the step it stopped at, or null, \"blocked_why\": \"why it stopped, or an empty string\", \"prod_caveat\": \"what to re-test against production, or an empty string\"}. When you are handed a RETEST (a finding an earlier run verified, with what the same request returns now), rule on whether it still holds, and on nothing else. It is \"still-reproducible\" only if the response now proves the weakness as it did then. It is \"fixed\" only if the same request now gets a response that shows the weakness is gone (a refusal, a corrected value): an error, a timeout, a missing page or a logged-out answer is not a fix. Anything else is \"cannot-confirm\". For a retest, output the block in this form instead: {\"kind\": \"retest\", \"title\": \"the finding's title as given\", \"result\": \"still-reproducible\" | \"fixed\" | \"cannot-confirm\", \"evidence\": \"the request or command and the response now\", \"quotes\": [\"one to three short excerpts of the response now, copied character for character\"], \"note\": \"one line on why\"}.",
    READ_ONLY,
  ),
  "recon-escalate": subagent(
    modelFor("escalate"),
    "Frontier escalation: called only when the executor is stuck or a High/Critical candidate needs deep adversarial review or multi-step exploit-chain reasoning. Read-only.",
    "You are the escalation reviewer, called rarely and only for hard cases: a stuck executor, or a High/Critical candidate that must survive adversarial scrutiny before it is reported. Reason carefully about exploitability and chaining, demand evidence, and be willing to downgrade or reject. Do not run tools; reason over what you are given and return a precise recommendation.",
    READ_ONLY,
  ),
});
