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
 * SECURITY — the approval gate. `classifyCommand` is the security boundary. Two
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

export function activeProfileName(): string {
  return (process.env.RECON_PROFILE || "").trim() || DEFAULT_PROFILE;
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

function tierOrder(): string[] {
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
}

/** Pure read filters: safe to run on piped stdin with pattern/field operands. */
const FILTERS = new Set(["grep", "egrep", "fgrep", "rg", "head", "tail", "cut", "sort", "uniq", "jq", "wc", "column", "tr"]);
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
  if (/[\r\n\\$`;&<>(){}*?!~]/.test(command)) return "ask";
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
  if (FILTERS.has(bin)) return isFirst ? "ask" : filterAllow(bin, args);
  return "ask";
}

/** A non-flag operand that looks like a file path. */
const FILE_OPERAND = /\/|^~|\.(?:html?|json|txt|log|xml|js|ts|csv|conf|env|pem|key|ya?ml|sh|py|ini|cfg|db|sqlite|md)$/i;

/** curl is safe only as a GET/HEAD to exactly the in-scope origin, via a positive
 *  flag allowlist (unknown flag -> ask), no redirects, no file read/write. */
function curlAllow(args: string[], ctx: GateContext): "allow" | "ask" {
  if (!ctx.scopeHost) return "ask";
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
        if ((flag === "--header" || flag === "--cookie") && v.startsWith("@")) return "ask"; // @file read
        continue;
      }
      return "ask";
    }
    if (a.startsWith("-") && a.length > 1) {
      if (CURL_SAFE_NOVAL.has(a)) continue;
      if (CURL_SAFE_VAL.has(a)) {
        const v = args[++i];
        if (v === undefined) return "ask";
        if ((a === "-H" || a === "-b") && v.startsWith("@")) return "ask";
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

/** A read filter, on piped stdin, with no file-path operands (no file reads). */
function filterAllow(bin: string, args: string[]): "allow" | "ask" {
  if (bin === "sort" && args.some((a) => a === "-o" || a === "--output" || a.startsWith("--output="))) return "ask";
  for (const a of args) {
    if (a.startsWith("-")) continue;
    if (FILE_OPERAND.test(a)) return "ask"; // a file operand would read a file instead of stdin
  }
  return "allow";
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
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN",
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
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  standardId?: string;
  repro: string;
  verdict: "real" | "config-dependent" | "rejected";
  prodCaveat?: string;
  env: EnvFidelity["kind"];
}

/* ═══════════════════════ OpenCode subagents ═══════════════════════ */

/** Read-only tool posture for the reviewer roles — webfetch off too, since they
 *  read untrusted target output (don't let them reach back out). */
const READ_ONLY_TOOLS = { bash: false, edit: false, write: false, task: false, webfetch: false } as const;

function executorTools(): Record<string, boolean> {
  const full = harnessFor("executor").tools === "full";
  return { bash: true, read: true, task: true, edit: full, write: full, webfetch: false };
}

function subagent(model: string, description: string, prompt: string, tools: Record<string, boolean>) {
  return { model, mode: "subagent" as const, description, prompt, tools };
}

/**
 * The recon subagents, resolved at import (profile/env at server start);
 * `routeModel` re-resolves live for escalation/shedding. Restart to re-register
 * after a profile change.
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
