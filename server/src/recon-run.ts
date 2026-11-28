/**
 * Supervised recon — the OpenCode side of the loop.
 * -----------------------------------------------------------------------------
 * recon-driver.ts decides WHAT happens next (which model, when to stop);
 * this file makes one executor turn actually happen and reads it back:
 *
 *   1. send the prompt to the session's `recon` agent on the routed model;
 *   2. while the turn runs, answer each permission OpenCode raises, from the
 *      gate: allow -> reply "once", deny -> reply "reject", ask -> leave it for
 *      the person at the UI (the browser shows the card and replies itself);
 *   3. when the session goes idle, report tokens used, the verifier's findings
 *      and whether the executor said continue / stuck / done.
 *
 * It talks to OpenCode only through `ReconBackend`, so the event handling is
 * unit-tested against a scripted event stream (recon-run.test.ts). index.ts
 * supplies the real backend.
 *
 * One run per session, held in memory: a runner restart ends the run (the
 * session and its transcript stay).
 */
import type { ReconState } from "../../shared/agent.js";
import {
  driveRecon, extractReconCommand, parseTurnStatus, parseVerifierFindings, resolveHarness,
  type GateDecision, type ReconPermission, type ReconSessionRunner, type ReconTurnResult,
} from "./recon-driver.js";
import { activeProfileName, originOf, reconAgents, type EnvFidelity, type ReconChain, type ReconFinding, type ReconHarness, type ReconRecall, type ReconSessionUse, type PriorFinding, type ReconRetest, type ReconLead } from "./recon.js";
import { httpError } from "./errors.js";
import { EvidenceLog, type Proof } from "./recon-evidence.js";

/** The agent the driver prompts, and the subagent whose replies are verdicts. */
export const EXECUTOR_AGENT = "recon";
export const VERIFY_AGENT = "recon-verify";

/** How long a model that answered "rate limited" is routed around. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

/** What the runner needs from OpenCode. */
export interface ReconBackend {
  /** Subscribe to the project's raw OpenCode events. Resolves once subscribed. */
  events(): Promise<{ stream: AsyncIterable<unknown>; close(): void }>;
  prompt(args: { sessionID: string; agent: string; model: string; text: string }): Promise<void>;
  replyPermission(sessionID: string, permissionID: string, response: "once" | "reject"): Promise<void>;
  abort(sessionID: string): Promise<void>;
  /** The agents OpenCode has for this project, with the instructions each was given. Optional: a backend that cannot list them is not checked. */
  agents?(): Promise<{ name: string; prompt?: string }[]>;
}

/**
 * The recon agents OpenCode is missing or holds without instructions. A run on such an
 * install looks healthy and records nothing: the verifier answers in prose, and only a
 * ruling in the format its instructions ask for is read. Seen live on a Docker install
 * whose compose override still mounted an opencode.json from before these agents existed.
 */
export function agentsWithoutInstructions(agents: readonly { name: string; prompt?: string }[]): string[] {
  return Object.keys(reconAgents()).filter((name) => !agents.find((a) => a.name === name)?.prompt?.trim());
}

/** A gate decision, for the audit log. */
export interface GateRecord { session: string; tool: string; command?: string; decision: GateDecision }

interface Turn {
  model: string;
  gate: (p: ReconPermission) => GateDecision;
  resolve(r: ReconTurnResult): void;
  reject(e: Error): void;
  tokensAtStart: number;
  /** An assistant message of the root session was seen: an `idle` now ends THIS turn. */
  sawAssistant: boolean;
  toolsCompleted: Set<string>;
  /** Root-session text parts of this turn: part id -> { message, text }. */
  texts: Map<string, { messageID: string; text: string }>;
  findings: ReconFinding[];
  /** The verifier's replies this turn, as written: the chain pass reads its verdicts on attack paths from them. */
  verifierOutputs: string[];
}

const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as Record<string, any>) : {});
const isRateLimit = (msg: string) => /\b429\b|rate.?limit|too many requests|overloaded|quota/i.test(msg);

function errorMessage(err: unknown): string {
  const e = obj(err);
  const msg = obj(e.data).message ?? e.message ?? e.name;
  const status = obj(e.data).statusCode;
  return msg ? (status ? `${msg} (HTTP ${status})` : String(msg)) : JSON.stringify(err ?? {}).slice(0, 300);
}

/**
 * Runs executor turns on one OpenCode session and applies the gate to the
 * permissions that session and its subagents raise.
 */
export class OpencodeReconRunner implements ReconSessionRunner {
  /** Counters and the model in use, for the status the UI polls. */
  readonly gateCounts = { allowed: 0, asked: 0, denied: 0 };
  rounds = 0;
  model: string | undefined;

  private turn: Turn | null = null;
  private sub: { close(): void } | null = null;
  private aborted = false;
  /** The root session and the subagent sessions it spawned. */
  private readonly family: Set<string>;
  private readonly assistantMessages = new Set<string>();
  /** Latest token count per assistant message, across the family. */
  private readonly messageTokens = new Map<string, number>();
  /** Tool call -> its input, so a permission can be matched to the exact command. */
  private readonly toolInputs = new Map<string, Record<string, unknown>>();
  private readonly handledPermissions = new Set<string>();
  private readonly verified = new Set<string>();
  /** What the run's shell commands really returned, from the event stream: what quotes are held to. */
  readonly evidence = new EvidenceLog();
  private readonly recorded = new Set<string>();
  private readonly capped = new Map<string, number>();

  constructor(
    private readonly backend: ReconBackend,
    private readonly sessionID: string,
    private readonly env: EnvFidelity["kind"],
    private readonly onGate: (r: GateRecord) => void = () => {},
  ) {
    this.family = new Set([sessionID]);
  }

  get tokens(): number {
    let n = 0;
    for (const t of this.messageTokens.values()) n += t;
    return n;
  }

  /** Models to route around right now (those that recently answered "rate limited"). */
  rateLimited(): Partial<Record<string, boolean>> {
    const now = Date.now();
    const out: Record<string, boolean> = {};
    for (const [model, until] of this.capped) {
      if (until > now) out[model] = true; else this.capped.delete(model);
    }
    return out;
  }

  /** Subscribe to events. Call once, before the first turn. */
  async start(): Promise<void> {
    const sub = await this.backend.events();
    this.sub = sub;
    void (async () => {
      try {
        for await (const evt of sub.stream) this.handle(evt);
        this.fail(new Error("The event stream from OpenCode ended."));
      } catch (e) {
        this.fail(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  }

  /** Stop: abort the turn in OpenCode and end the run. */
  async stop(): Promise<void> {
    this.aborted = true;
    await this.backend.abort(this.sessionID).catch(() => {});
    this.fail(new Error("aborted"));
  }

  close(): void {
    this.sub?.close();
    this.sub = null;
  }

  get wasAborted(): boolean { return this.aborted; }

  /** Hold quotes to what this run's commands really returned. */
  proof(quotes: readonly string[]): Proof { return this.evidence.check(quotes); }

  /** Does this run own `sessionID` (the root or one of its subagent sessions)? */
  owns(sessionID: string): boolean { return this.family.has(sessionID); }

  async runTurn(args: { prompt: string; model: string; gate: (p: ReconPermission) => GateDecision }): Promise<ReconTurnResult> {
    if (this.aborted) throw new Error("aborted");
    if (this.turn) throw new Error("a recon turn is already running");
    this.model = args.model;
    const done = new Promise<ReconTurnResult>((resolve, reject) => {
      this.turn = {
        model: args.model, gate: args.gate, resolve, reject,
        tokensAtStart: this.tokens, sawAssistant: false,
        toolsCompleted: new Set(), texts: new Map(), findings: [], verifierOutputs: [],
      };
    });
    try {
      await this.backend.prompt({ sessionID: this.sessionID, agent: EXECUTOR_AGENT, model: args.model, text: args.prompt });
    } catch (e) {
      this.turn = null;
      throw e;
    }
    try {
      return await done;
    } finally {
      this.rounds += 1;
    }
  }

  private fail(e: Error): void {
    const t = this.turn;
    this.turn = null;
    t?.reject(e);
  }

  private finish(extra: Partial<ReconTurnResult> = {}): void {
    const t = this.turn;
    if (!t) return;
    this.turn = null;
    const text = [...t.texts.values()].filter((p) => this.assistantMessages.has(p.messageID)).map((p) => p.text).join("\n");
    t.resolve({
      tokensUsed: Math.max(0, this.tokens - t.tokensAtStart),
      findings: t.findings,
      text,
      verifierOutputs: t.verifierOutputs,
      ...parseTurnStatus(text, t.toolsCompleted.size),
      ...extra,
    });
  }

  /** One raw OpenCode event. Exposed for tests. */
  handle(evt: unknown): void {
    const type: unknown = obj(evt).type;
    const p = obj(obj(evt).properties);
    switch (type) {
      case "session.created":
      case "session.updated": {
        const info = obj(p.info);
        if (info.id && info.parentID && this.family.has(info.parentID)) this.family.add(info.id);
        return;
      }
      case "message.updated": {
        const info = obj(p.info);
        if (!info.id || info.role !== "assistant" || !this.family.has(info.sessionID)) return;
        const t = obj(info.tokens);
        this.messageTokens.set(info.id, (Number(t.input) || 0) + (Number(t.output) || 0) + (Number(t.reasoning) || 0));
        if (info.sessionID === this.sessionID) {
          this.assistantMessages.add(info.id);
          if (this.turn) this.turn.sawAssistant = true;
        }
        return;
      }
      case "message.part.updated": {
        const part = obj(p.part);
        if (!this.family.has(part.sessionID)) return;
        if (part.type === "tool") this.onToolPart(part);
        else if (part.type === "text" && part.sessionID === this.sessionID && this.turn && typeof part.text === "string") {
          this.turn.texts.set(part.id, { messageID: part.messageID, text: part.text });
        }
        return;
      }
      case "permission.asked":
      case "permission.updated": {
        // Older servers put the request in `properties`, newer ones may nest it.
        const perm = p.id ? p : obj(p.permission);
        if (perm.id && this.family.has(perm.sessionID)) this.onPermission(perm);
        return;
      }
      case "session.idle":
        // An idle with no assistant message yet is left over from before the prompt.
        if (p.sessionID === this.sessionID && this.turn?.sawAssistant) this.finish();
        return;
      case "session.error": {
        // A subagent's error comes back to the executor as a failed task call.
        if (p.sessionID && p.sessionID !== this.sessionID) return;
        if (!this.turn) return;
        if (this.aborted) return this.fail(new Error("aborted"));
        const msg = errorMessage(p.error);
        if (isRateLimit(msg)) {
          // Route around this model for a while; the driver picks a neighbour next round.
          this.capped.set(this.turn.model, Date.now() + RATE_LIMIT_COOLDOWN_MS);
          return this.finish({ madeProgress: true, stuck: false, done: false });
        }
        return this.fail(new Error(msg));
      }
    }
  }

  private onToolPart(part: Record<string, any>): void {
    const st = obj(part.state);
    if (part.callID && st.input && typeof st.input === "object") this.toolInputs.set(part.callID, st.input);
    if (st.status !== "completed" && st.status !== "error") return;
    // Every shell command of the run, the subagents' included: its output is the record quotes are checked against.
    if (part.tool === "bash" && part.callID && typeof st.output === "string" && !this.recorded.has(part.callID)) {
      this.recorded.add(part.callID);
      this.evidence.add(st.output);
    }
    if (part.sessionID !== this.sessionID || !this.turn) return;
    this.turn.toolsCompleted.add(part.callID);
    // The verifier's reply is the output of the executor's `task` call to it.
    if (part.tool !== "task" || st.status !== "completed" || this.verified.has(part.callID)) return;
    const input = obj(st.input);
    if ((input.subagent_type ?? input.agent) !== VERIFY_AGENT || typeof st.output !== "string") return;
    this.verified.add(part.callID);
    this.turn.findings.push(...parseVerifierFindings(st.output, this.env).map((f) => ({ ...f, proof: this.evidence.check(f.quotes) })));
    this.turn.verifierOutputs.push(st.output);
  }

  private onPermission(perm: Record<string, any>): void {
    if (this.handledPermissions.has(perm.id)) return;
    this.handledPermissions.add(perm.id);
    const tool = String(perm.permission ?? perm.type ?? "").toLowerCase();
    // The exact command: from the request if it carries one, else from the tool
    // call it belongs to. Never from `patterns` (a glob is not what runs).
    const callID = obj(perm.tool).callID ?? perm.callID;
    const fromCall = callID ? this.toolInputs.get(callID)?.command : undefined;
    const command = extractReconCommand(perm) ?? (typeof fromCall === "string" && fromCall.trim() ? fromCall : undefined);
    // No turn (a stray permission after a stop) fails closed: the person decides.
    const decision: GateDecision = this.turn ? this.turn.gate({ tool, command }) : "ask";
    this.onGate({ session: perm.sessionID, tool, command, decision });
    if (decision === "ask") { this.gateCounts.asked += 1; return; }
    if (decision === "allow") this.gateCounts.allowed += 1; else this.gateCounts.denied += 1;
    this.backend.replyPermission(perm.sessionID, perm.id, decision === "allow" ? "once" : "reject").catch(() => {
      // Could not answer it: it stays pending, and the person at the UI decides.
    });
  }
}

/* ═══════════════════════ the run registry ═══════════════════════ */

export interface ReconStart {
  sessionID: string;
  scope: string;
  objective: string;
  env: EnvFidelity;
  harness?: ReconHarness;
  backend: ReconBackend;
  /** Audit hook: run started/finished and every gate decision. */
  log?: (event: string, data: Record<string, unknown>) => void;
  /** What earlier runs verified on this target, for the run to start from (see recon-memory.ts). */
  prior?: ReconRecall;
  /** Retest mode: re-check these findings of earlier runs instead of exploring. */
  retest?: readonly PriorFinding[];
  /** The target's captured logged-in session, already written into the project folder. Removed when the run ends. */
  session?: ReconSessionUse;
  /** Called once, with the final state, when the run has ended (a batch starts its next worker on this). */
  onFinished?: (state: ReconState) => void;
  /** Keeps the finished run for later ones, and says whether it could. */
  remember?: (state: ReconState) => ReconState["kept"];
}

interface Run { state: ReconState; runner: OpencodeReconRunner }
const runs = new Map<string, Run>();

function snapshot(run: Run): ReconState {
  const { state, runner } = run;
  if (state.status === "running") {
    // Once the chain pass has started, `rounds` stays at the main loop's count and its own turns are counted apart.
    if (state.phase === "chains") state.chainRounds = Math.max(0, runner.rounds - state.rounds);
    else state.rounds = runner.rounds;
    state.tokens = runner.tokens;
    state.model = runner.model;
    state.gate = { ...runner.gateCounts };
  }
  return state;
}

/** The run started on this session, if any (running or finished). */
export function reconState(sessionID: string): ReconState | null {
  const run = runs.get(sessionID);
  return run ? snapshot(run) : null;
}

/** Is `sessionID` (a root or subagent session) part of a recon run that is still going? */
export function inRunningRecon(sessionID: string): boolean {
  for (const run of runs.values()) if (run.state.status === "running" && run.runner.owns(sessionID)) return true;
  return false;
}

/** Validate and normalise what the browser sent for the environment. */
export function parseEnvFidelity(raw: unknown): EnvFidelity {
  const r = obj(raw);
  const kind = r.kind === "staging" || r.kind === "production" ? r.kind : r.kind === "local" ? "local" : undefined;
  if (!kind) throw httpError(400, "env.kind must be local, staging or production");
  const divergences = typeof r.divergences === "string" ? r.divergences.trim().slice(0, 2000) : "";
  if (!divergences) throw httpError(400, "env.divergences is required: say how this instance differs from production (or that it does not)");
  const nonProdSettings = Array.isArray(r.nonProdSettings)
    ? r.nonProdSettings.filter((s): s is string => typeof s === "string" && Boolean(s.trim())).map((s) => s.trim().slice(0, 200)).slice(0, 50)
    : [];
  return nonProdSettings.length ? { kind, divergences, nonProdSettings } : { kind, divergences };
}

/**
 * Start a supervised recon run on a session and return its state. The loop runs
 * in the background; poll `reconState`. Throws 400 on bad input and 409 when the
 * session already has a run going.
 */
export async function startRecon(o: ReconStart): Promise<ReconState> {
  const scope = o.scope.trim();
  const objective = o.objective.trim();
  if (!originOf(scope).host) throw httpError(400, "scope must be one host or URL, e.g. https://staging.example.com");
  if (!objective) throw httpError(400, "objective is required");
  if (runs.get(o.sessionID)?.state.status === "running") throw httpError(409, "A recon run is already going on this session.");

  const harness = resolveHarness(o.harness);
  const bare = o.backend.agents ? agentsWithoutInstructions(await o.backend.agents()) : [];
  if (bare.length) {
    throw httpError(409, `The agent server has no instructions for ${bare.join(", ")}, so a run would record nothing. Its opencode.json is older than this version: in Docker, look for a compose override that mounts its own opencode.json over the image's, and remove or update it.`);
  }
  const runner = new OpencodeReconRunner(o.backend, o.sessionID, o.env.kind,
    (r) => o.log?.("recon.gate", { ...r, root: o.sessionID }));
  const state: ReconState = {
    sessionID: o.sessionID, scope, objective, env: o.env, profile: activeProfileName(),
    status: "running", rounds: 0, maxRounds: harness.maxRounds!, tokens: 0, budgetTokens: harness.budgetTokens!,
    gate: { allowed: 0, asked: 0, denied: 0 }, findings: [], startedAt: Date.now(),
    ...(o.retest?.length ? { mode: "retest" as const, retests: [] } : {}),
    ...(o.session ? { session: { capturedAt: o.session.capturedAt, cookies: o.session.cookies, authorization: o.session.authorization } } : {}),
    ...(o.prior ? { memory: { runs: o.prior.runs, findings: o.prior.findings.length, paths: o.prior.paths.length, lastRun: o.prior.lastRun } } : {}),
  };
  const run: Run = { state, runner };
  await runner.start(); // subscribed before the first prompt, so no event is missed
  runs.set(o.sessionID, run);
  o.log?.("recon.started", { session: o.sessionID, scope, objective, env: o.env, profile: state.profile, maxRounds: state.maxRounds, budgetTokens: state.budgetTokens });

  let lastError: string | undefined;
  const seam: ReconSessionRunner = {
    proof: (quotes) => runner.proof(quotes),
    async runTurn(args) {
      try {
        const res = await runner.runTurn(args);
        state.findings.push(...res.findings.filter((f) => f.verdict !== "rejected"));
        return res;
      } catch (e) {
        lastError = String((e as Error)?.message ?? e);
        throw e;
      }
    },
  };
  const onChainPass = (chains: readonly ReconChain[]) => {
    if (state.phase !== "chains") { state.rounds = runner.rounds; state.phase = "chains"; }
    state.chains = [...chains];
  };
  const onRetest = (retests: readonly ReconRetest[]) => { state.retests = [...retests]; };
  const onLeads = (leads: readonly ReconLead[]) => { state.leads = leads.map((l) => ({ ...l })); };
  // A path recorded during the main loop: shown at once, and the run stays in its main phase.
  const onChains = (chains: readonly ReconChain[]) => { state.chains = [...chains]; };
  void driveRecon({ objective, scope, env: o.env, runner: seam, harness, rateLimited: () => runner.rateLimited(), onChainPass, onChains, prior: o.prior, session: o.session, retest: o.retest, onRetest, onLeads })
    .then((result) => {
      snapshot(run); // last live numbers before the status flips
      state.status = "finished";
      state.stopped = runner.wasAborted ? "aborted" : result.stopped;
      state.findings = result.findings;
      state.chains = result.chains;
      if (result.leads.length) state.leads = result.leads;
      if (result.retests) state.retests = result.retests;
      else state.chainPass = result.chainPass; // a retest run has no chain pass to report on
      state.rounds = result.rounds;
      state.chainRounds = result.chainRounds;
      if (state.stopped === "error" || state.chainPass === "error") state.error = lastError;
      state.finishedAt = Date.now();
      runner.close();
      try { o.session?.cleanup(); } catch { /* the folder is gone or not ours to remove */ }
      if (o.remember) {
        try { state.kept = o.remember(state); } catch { state.kept = "off"; }
      }
      try { o.onFinished?.(state); } catch { /* the listener's failure is not the run's */ }
      o.log?.("recon.finished", {
        session: o.sessionID, stopped: state.stopped, rounds: state.rounds, tokens: state.tokens,
        gate: state.gate, findings: state.findings, chainPass: state.chainPass, chains: state.chains, error: state.error,
      });
    });
  return snapshot(run);
}

/** Stop the run on this session. Returns its state, or null when there is none. */
export async function stopRecon(sessionID: string): Promise<ReconState | null> {
  const run = runs.get(sessionID);
  if (!run) return null;
  if (run.state.status === "running") await run.runner.stop();
  return snapshot(run);
}
