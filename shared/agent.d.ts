/**
 * The contract between the server's OpenCode bridge and the browser.
 *
 * Types only (a .d.ts), so both workspaces can `import type` it without a
 * build step or runtime dependency: `server/src/opencode.ts` must produce
 * these shapes and `web/src/agentApi.ts` consumes them, so a change on one
 * side fails the other side's type-check.
 */

export interface Tokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled" | string;
  priority?: string;
}

export interface AgentQuestion {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  /** Allow picking several options. */
  multiple?: boolean;
  /** Allow a typed answer (default true). */
  custom?: boolean;
}

/** A model OpenCode can use, as "provider/model". */
export interface AgentModel {
  id: string;
  name: string;
  provider: string;
  context?: number;
  output?: number;
  /** Accepts image input. */
  images?: boolean;
}

export interface SessionSummary {
  id: string;
  title?: string;
  created?: number;
  updated?: number;
  files: number;
  additions: number;
  deletions: number;
}

export interface SlashCommand {
  name: string;
  description: string;
  hint: string;
}

/** Per-file change recorded by OpenCode for a session. */
export interface FileDiff {
  file: string;
  /** Unified patch (current OpenCode) … */
  patch?: string;
  /** … or full before/after text (older OpenCode). */
  before?: string;
  after?: string;
  additions?: number;
  deletions?: number;
  status?: string;
  /** Which prompt in the session made the change (1-based). */
  turn?: number;
}

// --- Transcript parts (stored messages and live events share these) ---------

export interface TextPart { type: "text"; id: string; text: string }
export interface ReasoningPart { type: "reasoning"; id: string; text: string }
export interface ToolPart {
  type: "tool";
  callID: string;
  tool: string;
  /** "interrupted": left running by a turn that was cut off; nothing will complete it. */
  status: "pending" | "running" | "completed" | "error" | "interrupted" | string;
  title?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}
export interface FilePart {
  type: "file";
  id: string;
  filename?: string;
  mime?: string;
  /** Inline image (data: URL) for a thumbnail. */
  url?: string;
  size?: number;
}
export type MessagePart = TextPart | ReasoningPart | ToolPart | FilePart;

/** A message as stored by OpenCode, mapped to the browser's part shapes. */
export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  tokens?: Tokens;
  cost?: number;
  model?: string;
  /** When OpenCode began and finished the message, Unix ms; `completed` is unset while it is still going. */
  time?: { created?: number; completed?: number };
  error?: string;
  /** Set when a subagent (task tool) produced it: that session's title. */
  subagent?: string;
}

// --- Live events (GET /api/agent/events) -------------------------------------

export interface PermissionRequest {
  kind: "permission";
  sessionID: string;
  permissionID: string;
  permType?: string;
  title?: string;
  pattern?: string | string[];
  callID?: string;
  /** Raised by a subagent of the chat's session: that session's title. */
  subagent?: string;
}

export interface QuestionRequest {
  kind: "question";
  sessionID: string;
  requestID: string;
  questions: AgentQuestion[];
  callID?: string;
  subagent?: string;
}

/**
 * Live events. Anything a subagent session produces (the task tool spawns one
 * per delegation) is relayed with `subagent` set to that session's title, so
 * the browser can show it under the parent chat and answer its prompts.
 */
export type AgentEvent = AgentEventBase & { subagent?: string };

type AgentEventBase =
  | { kind: "open" }
  | { kind: "message"; messageID: string; role: "user" | "assistant" | string; tokens?: Tokens; cost?: number; model?: string }
  | { kind: "text"; messageID: string; partID?: string; text: string }
  | { kind: "reasoning"; messageID: string; partID?: string; text: string }
  | (Omit<ToolPart, "type"> & { kind: "tool"; messageID: string })
  | PermissionRequest
  | { kind: "permission-replied"; permissionID: string }
  | { kind: "todo"; sessionID?: string; todos: Todo[] }
  | { kind: "session"; sessionID: string; title?: string }
  | QuestionRequest
  | { kind: "question-closed"; requestID: string }
  | { kind: "idle"; sessionID?: string }
  | { kind: "error"; message: string };

/** GET /api/agent/pending */
export interface PendingRequests {
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
}

/** GET /api/agent/status */
export interface AgentStatus {
  ready: boolean;
  url: string;
  directory: string;
  defaultModel: string;
  models: AgentModel[];
}

// --- Supervised recon (server/src/recon-run.ts) --------------------------------

/** How the tested instance relates to production; every finding is tagged with `kind`. */
export interface ReconEnv {
  kind: "local" | "staging" | "production";
  /** How it differs from production, in the operator's words. */
  divergences: string;
  nonProdSettings?: string[];
}

/** A finding the verifier confirmed, or marked as depending on a non-production setting. */
export interface ReconFinding {
  /** "F1", "F2", …: how an attack path names the finding. */
  id?: string;
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  standardId?: string;
  repro: string;
  verdict: "real" | "config-dependent" | "rejected";
  prodCaveat?: string;
  env: ReconEnv["kind"];
  /** Excerpts of the response the verifier quoted as proof. */
  quotes?: string[];
  /**
   * How those quotes fared against what the run's commands really returned: `quoted` (all
   * found), `unmatched` (one was not), `unquoted` (none given). Absent on older findings.
   */
  proof?: "quoted" | "unmatched" | "unquoted";
}

/**
 * An attack path: findings of the run put together and tried end to end. `demonstrated`
 * means every step has its evidence; `partial` means it stopped at `blockedAt` and is a
 * lead, not a finding.
 */
export interface ReconChain {
  /** "P1", "P2", …. */
  id?: string;
  title: string;
  /** For a demonstrated path, never below the worst finding it uses. */
  severity: ReconFinding["severity"];
  /** Config-dependent when any finding it uses is. */
  verdict: "real" | "config-dependent";
  standardId?: string;
  /** What an attacker ends up with. */
  impact: string;
  /** Ids of the findings it uses. */
  links: string[];
  steps: { action: string; evidence?: string }[];
  status: "demonstrated" | "partial";
  blockedAt?: number;
  blockedWhy?: string;
  prodCaveat?: string;
  env: ReconEnv["kind"];
}

/** GET /api/agent/recon: one supervised recon run on a session. */
export interface ReconState {
  sessionID: string;
  scope: string;
  objective: string;
  env: ReconEnv;
  /** The model profile in use (recon-open, recon-balanced, …). */
  profile: string;
  status: "running" | "finished";
  /** Why it ended: the surface is done, nothing new (idle), a cap, stuck, rate limits, an error, or stopped by the user. */
  stopped?: "done" | "idle" | "budget" | "rounds" | "stuck" | "rate-limited" | "error" | "aborted";
  rounds: number;
  maxRounds: number;
  tokens: number;
  budgetTokens: number;
  /** The executor's model this round (it changes on escalation). */
  model?: string;
  /** Approvals the gate answered itself (allowed, denied) and left for the person (asked). */
  gate: { allowed: number; asked: number; denied: number };
  findings: ReconFinding[];
  /** "chains" once the chain pass has started: the main loop is over and the findings are being combined into attack paths. */
  phase?: "chains";
  /** Attack paths: the ones the executor showed while following a finding up in the main loop, then the chain pass's. */
  chains?: ReconChain[];
  /**
   * How the chain pass went, once the run has finished. `ran`: paths were proposed and tried.
   * Not run: `off`, `skipped` (the main loop ended on an error, rate limits or a stop),
   * `few-findings` (fewer than two), `budget`, `no-paths` (nothing proposed builds on a finding),
   * `rate-limited`. `error`: a turn of the pass failed; what it had recorded is kept.
   */
  chainPass?: "ran" | "off" | "skipped" | "few-findings" | "budget" | "no-paths" | "rate-limited" | "error";
  /** Turns the chain pass took. They are not counted in `rounds`, which `maxRounds` caps. */
  chainRounds?: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  /** What the executor noticed along the way and has not followed (open), and what came of the ones it has (closed). */
  leads?: ReconLead[];
  /** Components the executor fingerprinted, and what OSV and NVD list for those versions (looked up during the run). */
  components?: ReconComponent[];
  known?: ReconKnownVuln[];
  /** Components a database could not be asked about. */
  uncheckedComponents?: string[];
  /** "retest": the run re-checked findings of earlier runs instead of exploring. Absent for a normal run. */
  mode?: "retest";
  /** Retest mode: one outcome per finding re-checked so far. */
  retests?: ReconRetest[];
  /** The captured logged-in session the run was given, if any (counts only, never values). */
  session?: { capturedAt: number; cookies: number; authorization: boolean; headers?: string[] };
  /** What earlier runs on this target had verified, when the run started from it. */
  memory?: { runs: number; findings: number; paths: number; lastRun: number };
  /**
   * Whether the finished run is kept for later ones. `saved`: written, encrypted with the vault
   * key. `pending`: the vault was locked, so it is written at the next unlock (and lost if the
   * runner restarts first). `off`: there is no vault, so nothing is kept.
   */
  kept?: "saved" | "pending" | "off";
}

/** One target of a batch, and the recon run on it once it has started. */
export interface ReconBatchWorker {
  target: string;
  /**
   * `queued`: waiting for a free worker. `starting` / `running`: a run is going on `sessionID`.
   * `finished`: the run ended (see `recon.stopped` for how). `failed`: it could not be started.
   * `skipped`: never started, because the batch was stopped or its token budget was spent.
   */
  status: "queued" | "starting" | "running" | "finished" | "failed" | "skipped";
  /** The worker's session: open it from the session list to read what it did. */
  sessionID?: string;
  /** Why it failed or was skipped. */
  reason?: string;
  recon?: ReconState;
}

/** GET /api/agent/recon/batch: several targets tested at once, one worker each (server/src/recon-batch.ts). */
export interface ReconBatchState {
  id: string;
  status: "running" | "finished";
  /** The person stopped it. */
  stopped?: boolean;
  /** How many workers run at once. */
  maxWorkers: number;
  /** The token ceiling across all workers, if one was set. */
  budgetTokens?: number;
  tokens: number;
  workers: ReconBatchWorker[];
  startedAt: number;
  finishedAt?: number;
}

/** An approval a batch's worker is waiting on, with the target it is for. */
export interface ReconBatchApproval extends PermissionRequest {
  target: string;
}

/** A component the executor identified on the target, with its version (server/src/recon-cve.ts). */
export interface ReconComponent {
  name: string;
  version: string;
  /** The package ecosystem, when the executor named one (npm, PyPI, Packagist, …). */
  ecosystem?: string;
}

/**
 * A vulnerability a public database lists for a fingerprinted component's version. It is
 * about the version, not the target: a lead to test, never a finding by itself.
 */
export interface ReconKnownVuln {
  /** The CVE id when there is one, else the database's own id (a GHSA id, for example). */
  id: string;
  component: string;
  version: string;
  source: "osv" | "nvd";
  severity?: "low" | "medium" | "high" | "critical";
  summary: string;
  /** The day it was published (YYYY-MM-DD). */
  published?: string;
}

/** Something the executor noticed and did not get to at once (server/src/recon.ts). */
export interface ReconLead {
  id: string;
  text: string;
  status: "open" | "closed";
  outcome?: string;
  round: number;
}

/** The outcome of re-checking one finding an earlier run verified (server/src/recon.ts). */
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
  /** How the ruling's quotes fared against the run's real output. */
  proof?: "quoted" | "unmatched" | "unquoted";
}

/** GET /api/agent/recon/session: the logged-in session held for a target, without any value. */
export interface ReconSessionInfo {
  target: string;
  capturedAt: number;
  cookies: number;
  /** Whether an Authorization header was captured too. */
  authorization: boolean;
  /** Names of the custom login headers captured (x-auth-token, x-csrf-token, …). Never their values. */
  headers?: string[];
  /** When the first cookie with an expiry runs out (ms). Absent when every cookie is a session cookie. */
  firstExpiry?: number;
}

/** POST /api/agent/recon/session/pair: a single-use code for the browser extension. */
export interface ReconPairing {
  token: string;
  target: string;
  expiresAt: number;
}

/** GET /api/agent/recon/memory: what is remembered about one target. `target` is its host and port. */
export interface ReconMemoryTarget {
  target: string;
  runs: number;
  findings: number;
  paths: number;
  lastRun: number;
}

/** A folder under the workspace root (shared/agent.d.ts; server/src/workspaces.ts). */
export interface Workspace {
  /** Its path under the root: `demo`, or `owner/repo` for a GitHub clone. */
  name: string;
  directory: string;
  /** A git repository (the Changes view needs one). */
  git: boolean;
  modified: string | null;
}

export interface WorkspaceList {
  root: string;
  workspaces: Workspace[];
}

/** One entry of a project folder listing. */
export interface ProjectEntry {
  name: string;
  type: "file" | "dir";
  size: number;
  modified: string | null;
}

export interface ProjectListing {
  /** The listed folder, relative to the project ("" is the project itself). */
  path: string;
  entries: ProjectEntry[];
  /** More entries than are returned. */
  truncated: boolean;
}

export interface UploadResult {
  /** Where it was saved, relative to the project. */
  path: string;
  /** The name it was saved under (a clash gets -1, -2, …). */
  name: string;
  bytes: number;
}
