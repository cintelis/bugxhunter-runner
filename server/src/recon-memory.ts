/**
 * What supervised recon runs found, kept between runs and across restarts, encrypted with
 * the vault key.
 *
 * One file per finished run next to the vault: /data/recon in Docker (the runner-only
 * runner-data volume, never the agent's), ~/.config/bugxhunter/recon otherwise. Only an id
 * and the finish time are in the clear; the target, the session and everything the run
 * found are sealed, bound to the record by its AAD. A copied volume shows how many runs
 * there were and when, nothing about what was tested or found.
 *
 * Two things read it back: a new run on the same target starts from what earlier runs
 * verified there (`recall`), and a session shows its last run again after a restart
 * (`lastForSession`). Without a vault nothing is kept; with a locked one a finished run
 * waits in memory and is written when the vault is next unlocked.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Sealed } from "../../shared/vault.js";
import type { ReconMemoryTarget, ReconState } from "../../shared/agent.js";
import { VAULT_FILE, isInitialised, isUnsealed, onUnsealed, openData, sealData } from "./vault.js";
import { httpError } from "./errors.js";
import { audit } from "./audit.js";
import { originOf, type PriorFinding, type PriorPath, type ReconRecall } from "./recon.js";

const dir = () => process.env.OPEN_RUNNER_RECON_DIR ?? path.join(path.dirname(VAULT_FILE), "recon");

/** Runs kept in all; the oldest are dropped past this. */
export const MAX_RUNS = 300;
/** What one recall hands a new run: enough to start from, not the whole history. */
const MAX_RECALLED_FINDINGS = 40;
const MAX_RECALLED_PATHS = 10;
const MAX_PENDING = 20;
const ID = /^[0-9]{13}-[a-f0-9]{12}$/;

interface RunFile { v: 1; id: string; finishedAt: string; body: Sealed }
interface StoredRun { id: string; target: string; state: ReconState }

const aad = (id: string) => `recon:${id}:body`;
const file = (id: string) => path.join(dir(), `${id}.json`);

/** The key runs are grouped by: the target's host and port, whatever path or scheme the scope was typed with. */
export function targetKey(scope: string): string | undefined {
  const { host, port } = originOf(scope.trim());
  return host ? `${host}:${port}` : undefined;
}

function ids(): string[] {
  try {
    return fs.readdirSync(dir()).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter((id) => ID.test(id)).sort();
  } catch {
    return [];
  }
}

/** Every stored run that opens with the current vault, oldest first. Throws 503 while the vault is locked. */
function all(): StoredRun[] {
  // Said even when nothing is stored yet, so "locked" is never shown as "nothing remembered".
  if (isInitialised() && !isUnsealed()) throw httpError(503, "The vault is sealed (locked). Unlock it to read what earlier runs found.");
  const out: StoredRun[] = [];
  for (const id of ids()) {
    let r: RunFile;
    try { r = JSON.parse(fs.readFileSync(file(id), "utf8")) as RunFile; } catch { continue; }
    if (r?.v !== 1 || r.id !== id) continue;
    try {
      const body = JSON.parse(openData(r.body, aad(id))) as { target?: unknown; state?: ReconState };
      if (typeof body.target === "string" && body.state && Array.isArray(body.state.findings)) out.push({ id, target: body.target, state: body.state });
    } catch (e) {
      if ((e as { status?: number }).status === 503) throw e;
      // a record from another vault, or a tampered one: skipped, not fatal
    }
  }
  return out;
}

/** The same, or nothing when the vault is locked or absent: reading memory never fails a run. */
function allOrNone(): StoredRun[] {
  try { return all(); } catch { return []; }
}

function write(state: ReconState): void {
  const target = targetKey(state.scope);
  if (!target) return;
  const finishedAt = state.finishedAt ?? Date.now();
  const id = `${String(finishedAt).padStart(13, "0")}-${crypto.randomBytes(6).toString("hex")}`;
  const record: RunFile = { v: 1, id, finishedAt: new Date(finishedAt).toISOString(), body: sealData(JSON.stringify({ target, state }), aad(id)) };
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const tmp = `${file(id)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, file(id));
  const have = ids();
  for (const old of have.slice(0, Math.max(0, have.length - MAX_RUNS))) fs.rmSync(file(old), { force: true });
}

/** Finished runs that could not be written because the vault was locked. Held in this process only. */
const pending: ReconState[] = [];

/**
 * Keep a finished run. `saved`: written. `pending`: the vault is locked, so it waits in
 * memory until the next unlock (and is lost if the runner restarts first). `off`: there is
 * no vault, or the write failed, and nothing is kept.
 */
export function remember(state: ReconState): "saved" | "pending" | "off" {
  if (state.status !== "finished") return "off";
  try {
    write(state);
    audit("recon.remembered", { session: state.sessionID, findings: state.findings.length, paths: state.chains?.length ?? 0 });
    return "saved";
  } catch (e) {
    if ((e as { status?: number }).status === 503) {
      pending.push(state);
      if (pending.length > MAX_PENDING) pending.shift();
      return "pending";
    }
    return "off";
  }
}

/** Write the runs that finished while the vault was locked. */
export function flushPending(): void {
  for (const state of pending.splice(0)) {
    try {
      write(state);
      state.kept = "saved";
      audit("recon.remembered", { session: state.sessionID, findings: state.findings.length, paths: state.chains?.length ?? 0, late: true });
    } catch {
      // still not writable: this run is not kept
    }
  }
}
onUnsealed(flushPending);

const sameFinding = (title: string, standardId?: string) => `${title.toLowerCase().replace(/\s+/g, " ").trim()}|${(standardId ?? "").toLowerCase()}`;

/** What earlier runs on a target verified, newest first and without repeats. */
export function recallFrom(runs: readonly ReconState[]): ReconRecall | undefined {
  if (!runs.length) return undefined;
  const newestFirst = [...runs].sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt));
  const findings = new Map<string, PriorFinding>();
  const paths = new Map<string, PriorPath>();
  // A finding a later run retested and found fixed is no longer a lead: older runs' record of it is passed over.
  const fixed = new Set<string>();
  for (const run of newestFirst) {
    const seen = run.finishedAt ?? run.startedAt;
    for (const r of run.retests ?? []) {
      const key = sameFinding(r.title, r.standardId);
      if (r.result === "fixed" && !findings.has(key)) fixed.add(key);
    }
    for (const f of run.findings) {
      if (f.verdict === "rejected") continue;
      const key = sameFinding(f.title, f.standardId);
      if (fixed.has(key)) continue;
      const known = findings.get(key);
      if (known) { known.runs += 1; continue; }
      findings.set(key, { title: f.title, severity: f.severity, verdict: f.verdict, standardId: f.standardId, repro: f.repro, env: f.env, seen, runs: 1 });
    }
    for (const c of run.chains ?? []) {
      const key = sameFinding(c.title);
      if (paths.has(key)) continue;
      paths.set(key, { title: c.title, severity: c.severity, status: c.status, impact: c.impact, steps: c.steps.map((s) => s.action), seen });
    }
  }
  const rank = { critical: 3, high: 2, medium: 1, low: 0 } as const;
  return {
    runs: runs.length,
    lastRun: newestFirst[0].finishedAt ?? newestFirst[0].startedAt,
    findings: [...findings.values()].sort((a, b) => rank[b.severity] - rank[a.severity] || b.seen - a.seen).slice(0, MAX_RECALLED_FINDINGS),
    // Demonstrated paths first: a partial one is only a lead.
    paths: [...paths.values()].sort((a, b) => Number(b.status === "demonstrated") - Number(a.status === "demonstrated") || b.seen - a.seen).slice(0, MAX_RECALLED_PATHS),
  };
}

/** What earlier runs verified on this target, or undefined when there is nothing (or the vault is locked). */
export function recall(scope: string): ReconRecall | undefined {
  const target = targetKey(scope);
  if (!target) return undefined;
  return recallFrom(allOrNone().filter((r) => r.target === target).map((r) => r.state));
}

/** The last finished run on a session, so its results are still there after a restart. */
export function lastForSession(sessionID: string): ReconState | null {
  if (!sessionID) return null;
  const mine = allOrNone().filter((r) => r.state.sessionID === sessionID);
  return mine.length ? { ...mine[mine.length - 1].state, kept: "saved" } : null;
}

/** The targets something is remembered about, most recent first. Throws 503 while the vault is locked. */
export function targets(): ReconMemoryTarget[] {
  const by = new Map<string, ReconState[]>();
  for (const r of all()) by.set(r.target, [...(by.get(r.target) ?? []), r.state]);
  return [...by.entries()].map(([target, runs]) => {
    const r = recallFrom(runs)!;
    return { target, runs: r.runs, findings: r.findings.length, paths: r.paths.length, lastRun: r.lastRun };
  }).sort((a, b) => b.lastRun - a.lastRun);
}

/** Forget every run on one target. Returns how many were deleted. Throws 503 while the vault is locked. */
export function forget(scope: string): number {
  const target = targetKey(scope);
  if (!target) return 0;
  const mine = all().filter((r) => r.target === target);
  for (const r of mine) fs.rmSync(file(r.id), { force: true });
  for (let i = pending.length - 1; i >= 0; i--) if (targetKey(pending[i].scope) === target) pending.splice(i, 1);
  audit("recon.forgotten", { runs: mine.length });
  return mine.length;
}
