// What the recon panel says about a run's attack paths, kept apart from the markup so it can be tested.
import type { ReconBatchState, ReconBatchWorker, ReconChain, ReconMemoryTarget, ReconRetest, ReconSessionInfo, ReconState } from "../../shared/agent";

/** The targets typed into the start dialog: one per line (commas work too), blanks dropped. */
export function targetLines(text: string): string[] {
  return text.split(/[\r\n,]+/).map((t) => t.trim()).filter(Boolean);
}

/** A batch in a few words: "2 running, 1 queued, 3 finished, 1 failed". */
export function batchSummary(b: Pick<ReconBatchState, "workers">): string {
  const n = (...s: ReconBatchWorker["status"][]) => b.workers.filter((w) => s.includes(w.status)).length;
  const parts = [[n("starting", "running"), "running"], [n("queued"), "queued"], [n("finished"), "finished"], [n("failed"), "failed"], [n("skipped"), "skipped"]] as const;
  return `${b.workers.length} target${b.workers.length === 1 ? "" : "s"}: ${parts.filter(([c]) => c > 0).map(([c, label]) => `${c} ${label}`).join(", ")}`;
}

/** What to say beside a worker that is not simply running: why it failed or was skipped, or how its run ended. */
export function workerNote(w: Pick<ReconBatchWorker, "status" | "reason" | "recon">): string | null {
  if (w.status === "failed") return `could not start: ${w.reason ?? "unknown reason"}`;
  if (w.status === "skipped") return `not started: ${w.reason ?? "skipped"}`;
  if (w.status === "finished" && w.recon?.stopped) return `ended: ${w.recon.stopped}`;
  return null;
}

/** The badge and the hover text for how a verdict's quotes fared; null when they were not checked at all. */
export function proofBadge(proof: "quoted" | "unmatched" | "unquoted" | undefined): { text: string; kind: "ok" | "warn" | "none"; title: string } | null {
  switch (proof) {
    case "quoted": return { text: "evidence matched", kind: "ok", title: "Every excerpt the verifier quoted was found in what this run's commands returned." };
    case "unmatched": return { text: "evidence not matched", kind: "warn", title: "The verifier quoted text that this run's commands did not return: it was paraphrased, or made up. Check the reproduction yourself." };
    case "unquoted": return { text: "no quotes", kind: "none", title: "The verifier quoted nothing that could be checked against this run's output." };
    default: return null;
  }
}

/** The leads a run still has open, and how many it closed. */
export function splitLeads(leads: readonly { status: "open" | "closed" }[] | undefined): { open: number; closed: number } {
  const all = leads ?? [];
  const open = all.filter((l) => l.status === "open").length;
  return { open, closed: all.length - open };
}

export const RETEST_LABEL: Record<ReconRetest["result"], string> = {
  "still-reproducible": "still reproducible",
  fixed: "fixed",
  "cannot-confirm": "could not be confirmed",
};

/** A retest run in one line: "2 still reproducible, 1 fixed, 1 could not be confirmed". */
export function retestSummary(retests: readonly ReconRetest[] | undefined): string {
  const all = retests ?? [];
  if (!all.length) return "nothing retested yet";
  return (["still-reproducible", "fixed", "cannot-confirm"] as const)
    .map((r) => [all.filter((t) => t.result === r).length, RETEST_LABEL[r]] as const)
    .filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`).join(", ");
}

/** Why a run ended, where retest mode reads differently from a normal run. */
export function retestStopReason(r: Pick<ReconState, "mode" | "stopped">): string | null {
  return r.mode === "retest" && r.stopped === "done" ? "every remembered finding was retested" : null;
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** What is remembered about a target, in a few words: "2 earlier runs, 5 findings, 1 attack path (last 2026-11-20)". */
export function memorySummary(m: Pick<ReconMemoryTarget, "runs" | "findings" | "paths" | "lastRun">): string {
  const parts = [count(m.runs, "earlier run"), count(m.findings, "finding")];
  if (m.paths) parts.push(count(m.paths, "attack path"));
  return `${parts.join(", ")} (last ${day(m.lastRun)})`;
}

const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** A captured session in a few words: "captured 2026-11-28 09:10 UTC: 6 cookies and the Authorization header". */
export function sessionSummary(s: Pick<ReconSessionInfo, "capturedAt" | "cookies" | "authorization" | "firstExpiry">, now = Date.now()): string {
  const parts = [count(s.cookies, "cookie")];
  if (s.authorization) parts.push("the Authorization header");
  const expiry = s.firstExpiry === undefined ? "" : s.firstExpiry <= now ? "; a cookie has expired, capture it again" : `; first cookie expires ${minute(s.firstExpiry)}`;
  return `captured ${minute(s.capturedAt)}: ${parts.join(" and ")}${expiry}`;
}

/** One line when the run was given a logged-in session. */
export function sessionNote(r: Pick<ReconState, "session">): string | null {
  if (!r.session) return null;
  const parts = [count(r.session.cookies, "cookie")];
  if (r.session.authorization) parts.push("the Authorization header");
  return `Tested with a logged-in session (${parts.join(" and ")}, captured ${minute(r.session.capturedAt)}).`;
}

/** One line when the run started from what earlier runs verified. */
export function memoryNote(r: Pick<ReconState, "memory">): string | null {
  return r.memory ? `Started from ${memorySummary(r.memory)} on this target. Only what was reproduced in this run is listed here.` : null;
}

/** One line when a finished run was not written to memory. Null when it was, or the run is still going. */
export function keptNote(r: Pick<ReconState, "status" | "kept">): string | null {
  if (r.status !== "finished") return null;
  if (r.kept === "pending") return "Not saved yet: the vault is locked. Unlock it and this run is kept for the next one on this target.";
  if (r.kept === "off") return "Not kept for later runs: that needs the vault (sidebar → keys).";
  return null;
}

/** Attack paths that held, and the ones that stopped: leads, shown apart and never counted as findings. */
export function splitPaths(chains: readonly ReconChain[] | undefined): { demonstrated: ReconChain[]; partial: ReconChain[] } {
  const all = chains ?? [];
  return { demonstrated: all.filter((c) => c.status === "demonstrated"), partial: all.filter((c) => c.status === "partial") };
}

/** Ids of the attack paths that build on a finding, demonstrated ones first. */
export function pathsUsing(findingId: string | undefined, chains: readonly ReconChain[] | undefined): string[] {
  if (!findingId) return [];
  const { demonstrated, partial } = splitPaths(chains);
  return [...demonstrated, ...partial].filter((c) => c.links.includes(findingId)).map((c) => c.id).filter((id): id is string => Boolean(id));
}

/** Where a partial path stopped, in words. */
export function stoppedAt(c: ReconChain): string {
  const why = c.blockedWhy?.trim() || "not shown";
  return c.blockedAt ? `Stopped at step ${c.blockedAt}: ${why}` : `Not shown: ${why}`;
}

/** The round counter: the main loop's rounds, or the chain pass's turns once that has started. */
export function progressLabel(r: Pick<ReconState, "status" | "phase" | "rounds" | "maxRounds" | "chainRounds">): string {
  const running = r.status === "running";
  if (running && r.phase === "chains") return `chaining findings · turn ${(r.chainRounds ?? 0) + 1}`;
  const main = `round ${running ? r.rounds + 1 : r.rounds}/${r.maxRounds}`;
  return !running && r.chainRounds ? `${main} · ${r.chainRounds} chaining` : main;
}

/**
 * One line on why a finished run shows no attack paths, or that the pass was cut short.
 * Null when there is nothing to explain: the pass ran, or the run is still going.
 */
export function chainPassNote(r: Pick<ReconState, "status" | "chainPass" | "chains">): string | null {
  if (r.status !== "finished") return null;
  // A path can be recorded during the main loop, so "none were looked for" would be wrong then.
  const none = r.chains?.length ? "No further attack paths were looked for" : "Attack paths were not looked for";
  switch (r.chainPass) {
    case "ran": return r.chains?.length ? null : "No attack path was recorded.";
    case "off": return `${none}: the chain pass was turned off for this run.`;
    case "skipped": return `${none}: the run ended before the chain pass.`;
    case "few-findings": return `${none}: it takes at least two findings to combine.`;
    case "budget": return `${none}: the token budget was spent.`;
    case "no-paths": return r.chains?.length
      ? "The findings were reviewed for further attack paths and no other combination was proposed."
      : "The findings were reviewed for attack paths and no combination was proposed.";
    case "rate-limited": return "The chain pass stopped: every model was rate-limited.";
    case "error": return "The chain pass stopped early. What it had recorded is shown.";
    default: return null; // a run from before the chain pass existed
  }
}
