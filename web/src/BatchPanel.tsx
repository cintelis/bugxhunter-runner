/**
 * Concurrency mode in the Runner: several targets tested at once, one recon run each
 * (server/src/recon-batch.ts). This shows the batch as a whole: its workers and where each
 * has got to, every approval any of them is waiting on (each marked with its target), and
 * what each found. A worker is an ordinary session: open it from the session list to read
 * its transcript.
 */
import { formatTokens } from "./format";
import { ReconFindings } from "./ReconPanel";
import { batchSummary, progressLabel, workerNote } from "./reconView";
import type { ReconBatchApproval, ReconBatchState, ReconBatchWorker } from "../../shared/agent";

interface Props {
  batch: ReconBatchState;
  approvals: ReconBatchApproval[];
  onReply: (a: ReconBatchApproval, response: "once" | "reject") => void;
  onStop: () => void;
  onDismiss: () => void;
}

export function BatchPanel({ batch, approvals, onReply, onStop, onDismiss }: Props) {
  const running = batch.status === "running";
  return (
    <div className="batch-panel">
      <div className={"recon-strip" + (running ? " live" : "")} role="status">
        <span className="recon-name">recon batch</span>
        <span>{batchSummary(batch)}</span>
        <span>up to {batch.maxWorkers} at a time</span>
        <span>{formatTokens(batch.tokens)}{batch.budgetTokens ? `/${formatTokens(batch.budgetTokens)}` : ""} tokens</span>
        {running
          ? <button className="btn sm danger-outline" onClick={onStop}>stop all</button>
          : (
            <>
              <span className="recon-end">ended{batch.stopped ? ": stopped by you" : ""}</span>
              <button className="link-btn" onClick={onDismiss}>dismiss</button>
            </>
          )}
      </div>

      {approvals.length > 0 && (
        <div className="batch-approvals">
          <div className="perm-title">Approvals waiting ({approvals.length})</div>
          {approvals.map((a) => (
            <div className="perm-card" key={a.permissionID}>
              <div className="perm-title">
                <span className="badge recon-id">{a.target}</span>
                {a.subagent && <span className="perm-sub">subagent · {a.subagent}</span>}
              </div>
              <div className="perm-body">
                <span className="perm-type">{a.permType ?? "action"}</span>{" "}
                {a.title ?? (Array.isArray(a.pattern) ? a.pattern.join(", ") : a.pattern) ?? ""}
              </div>
              <div className="perm-actions">
                {/* One command at a time, as in any recon run: the gate sees the next one too. */}
                <button className="btn primary sm" onClick={() => onReply(a, "once")}>Approve</button>
                <button className="btn sm danger-outline" onClick={() => onReply(a, "reject")}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="batch-workers">
        {batch.workers.map((w) => <WorkerRow key={w.target} w={w} />)}
      </div>
    </div>
  );
}

function WorkerRow({ w }: { w: ReconBatchWorker }) {
  const r = w.recon;
  const note = workerNote(w);
  const found = r ? r.findings.length + (r.chains?.length ?? 0) : 0;
  return (
    <details className={`batch-worker ${w.status}`} open={w.status === "finished" && found > 0 ? undefined : false}>
      <summary>
        <span className={`badge batch-${w.status}`}>{w.status}</span>
        <span className="mono batch-target">{w.target}</span>
        {r && <span>{progressLabel(r)}</span>}
        {r && <span>{formatTokens(r.tokens)}/{formatTokens(r.budgetTokens)} tokens</span>}
        {r && <span>{r.findings.length} finding{r.findings.length === 1 ? "" : "s"}{r.chains?.length ? `, ${r.chains.length} path${r.chains.length === 1 ? "" : "s"}` : ""}</span>}
        {note && <span className="recon-in-paths">{note}</span>}
      </summary>
      {r ? <ReconFindings recon={r} /> : <div className="hint">Nothing yet.</div>}
      {w.sessionID && <div className="hint">Its transcript is the session "recon {w.target}" in the session list.</div>}
    </details>
  );
}
