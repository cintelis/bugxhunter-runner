/**
 * Supervised recon in the Runner: the dialog that starts a run (scope,
 * objective, how the instance differs from production, and the operator's
 * statement of authorisation), the strip that shows a run's progress, and the
 * findings the verifier confirmed.
 *
 * The loop itself runs on the server (server/src/recon-run.ts); the browser
 * starts it, polls its state, and answers the approvals the gate leaves open.
 */
import { useState } from "react";
import { Dialog } from "./Dialog";
import { formatTokens } from "./format";
import type { ReconEnv, ReconFinding, ReconState } from "../../shared/agent";

export interface ReconRequest {
  scope: string;
  objective: string;
  env: ReconEnv;
}

const STOP_REASON: Record<NonNullable<ReconState["stopped"]>, string> = {
  done: "the executor reported the in-scope surface exhausted",
  idle: "a round found nothing new",
  budget: "the token budget is spent",
  rounds: "the round limit was reached",
  stuck: "the executor stayed stuck, even after escalating",
  "rate-limited": "every model is rate-limited",
  error: "a round failed",
  aborted: "stopped by you",
};

export function ReconDialog({ onStart, onClose }: { onStart: (r: ReconRequest) => Promise<void>; onClose: () => void }) {
  const [scope, setScope] = useState("");
  const [objective, setObjective] = useState("Map the attack surface and test access control, authentication and injection, one hypothesis at a time.");
  const [kind, setKind] = useState<ReconEnv["kind"]>("staging");
  const [divergences, setDivergences] = useState("");
  const [settings, setSettings] = useState("");
  const [authorised, setAuthorised] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = scope.trim() && objective.trim() && divergences.trim() && authorised && !busy;
  async function start() {
    setBusy(true); setError(null);
    try {
      const nonProdSettings = settings.split(",").map((s) => s.trim()).filter(Boolean);
      await onStart({
        scope: scope.trim(), objective: objective.trim(),
        env: { kind, divergences: divergences.trim(), ...(nonProdSettings.length ? { nonProdSettings } : {}) },
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog title="recon --supervised" onClose={busy ? undefined : onClose}>
      <p>
        The agent tests one target round after round: it enumerates, forms a hypothesis, probes it and hands candidates to a
        verifier. Read-only requests to the target run on their own; anything else waits for your approval.
      </p>
      <div className="field">
        <label htmlFor="recon-scope">Target (one host or URL)</label>
        <input id="recon-scope" type="text" className="mono" autoFocus spellCheck={false} placeholder="https://staging.example.com"
          value={scope} onChange={(e) => setScope(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="recon-objective">Objective</label>
        <textarea id="recon-objective" rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="recon-kind">Environment</label>
        <select id="recon-kind" value={kind} onChange={(e) => setKind(e.target.value as ReconEnv["kind"])}>
          <option value="local">local</option>
          <option value="staging">staging</option>
          <option value="production">production</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="recon-div">How it differs from production</label>
        <textarea id="recon-div" rows={2} placeholder="e.g. seed data, SSO replaced by a test login; or: none, this is production"
          value={divergences} onChange={(e) => setDivergences(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="recon-settings">Non-production settings (optional, comma-separated)</label>
        <input id="recon-settings" type="text" className="mono" spellCheck={false} placeholder="DEBUG=1, AUTH_DISABLED"
          value={settings} onChange={(e) => setSettings(e.target.value)} />
      </div>
      <label className="recon-consent">
        <input type="checkbox" checked={authorised} onChange={(e) => setAuthorised(e.target.checked)} />
        <span>I am authorised to test this target, and it is the only one in scope.</span>
      </label>
      {error && <div className="hint danger">{error}</div>}
      <div className="perm-actions recon-actions">
        <button className="btn primary sm" disabled={!ready} onClick={start}>{busy ? "starting…" : "start recon"}</button>
        <button className="btn sm" disabled={busy} onClick={onClose}>cancel</button>
      </div>
    </Dialog>
  );
}

/** A run's progress while it is going, and how it ended. */
export function ReconStrip({ recon, onStop, onDismiss }: { recon: ReconState; onStop: () => void; onDismiss: () => void }) {
  const running = recon.status === "running";
  return (
    <div className={"recon-strip" + (running ? " live" : "")} role="status">
      <span className="recon-name">recon</span>
      <span className="mono" title={recon.objective}>{recon.scope}</span>
      <span>round {running ? recon.rounds + 1 : recon.rounds}/{recon.maxRounds}</span>
      <span>{formatTokens(recon.tokens)}/{formatTokens(recon.budgetTokens)} tokens</span>
      {running && recon.model && <span title={`profile ${recon.profile}`}>{recon.model}</span>}
      <span title="Approvals the gate answered itself, and the ones it left for you">
        auto-allowed {recon.gate.allowed} · asked {recon.gate.asked} · blocked {recon.gate.denied}
      </span>
      {running
        ? <button className="btn sm danger-outline" onClick={onStop}>stop</button>
        : (
          <>
            <span className="recon-end">ended: {recon.stopped ? STOP_REASON[recon.stopped] : "finished"}</span>
            <button className="link-btn" onClick={onDismiss}>dismiss</button>
          </>
        )}
    </div>
  );
}

/** The verifier's findings. All of this is model output about the target: shown as plain text. */
export function ReconFindings({ recon }: { recon: ReconState }) {
  if (recon.status === "running" && !recon.findings.length) return null;
  return (
    <div className="recon-findings">
      <div className="perm-title recon-title">
        Recon findings ({recon.findings.length}) · {recon.env.kind}
      </div>
      {recon.error && <div className="hint danger">{recon.error}</div>}
      {!recon.findings.length && <div className="hint">The verifier confirmed no findings in this run.</div>}
      {recon.findings.map((f, i) => <FindingCard key={i} f={f} />)}
    </div>
  );
}

function FindingCard({ f }: { f: ReconFinding }) {
  return (
    <div className="recon-finding">
      <div className="recon-finding-head">
        <span className={`badge sev-${f.severity}`}>{f.severity}</span>
        <span className="recon-finding-title">{f.title}</span>
        {f.standardId && <span className="badge">{f.standardId}</span>}
        {f.verdict === "config-dependent" && <span className="badge sev-medium">config-dependent</span>}
      </div>
      <pre className="recon-repro">{f.repro}</pre>
      {f.prodCaveat && <div className="hint">Re-test against production: {f.prodCaveat}</div>}
    </div>
  );
}
