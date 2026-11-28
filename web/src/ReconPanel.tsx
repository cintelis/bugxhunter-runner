/**
 * Supervised recon in the Runner: the dialog that starts a run (scope,
 * objective, how the instance differs from production, and the operator's
 * statement of authorisation), the strip that shows a run's progress, and what
 * the verifier confirmed: the findings, and the attack paths that combine them.
 *
 * The loop itself runs on the server (server/src/recon-run.ts); the browser
 * starts it, polls its state, and answers the approvals the gate leaves open.
 */
import { useEffect, useState } from "react";
import { reconMemoryForget, reconMemoryGet, reconSessionForget, reconSessionGet, reconSessionPair } from "./agentApi";
import { Dialog } from "./Dialog";
import { formatTokens } from "./format";
import {
  chainPassNote, keptNote, memoryNote, memorySummary, pathsUsing, progressLabel, proofBadge, RETEST_LABEL, retestStopReason, retestSummary,
  sessionNote, sessionSummary, splitPaths, stoppedAt,
} from "./reconView";
import type { ReconChain, ReconEnv, ReconFinding, ReconMemoryTarget, ReconPairing, ReconRetest, ReconSessionInfo, ReconState } from "../../shared/agent";

export interface ReconRequest {
  scope: string;
  objective: string;
  env: ReconEnv;
  /** Whether to look for attack paths once the main loop ends. */
  chainPass: { enabled: boolean };
  /** Whether to start from what earlier runs verified on this target. */
  useMemory: boolean;
  /** Whether to give the run the logged-in session captured for this target. */
  useSession: boolean;
  /** "retest": re-check what is remembered about the target instead of exploring it. */
  mode?: "retest";
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
  const [chain, setChain] = useState(true);
  const [memory, setMemory] = useState<ReconMemoryTarget | null>(null);
  const [useMemory, setUseMemory] = useState(true);
  const [retest, setRetest] = useState(false);
  const [session, setSession] = useState<ReconSessionInfo | null>(null);
  const [useSession, setUseSession] = useState(true);
  const [pairing, setPairing] = useState<ReconPairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Look up what earlier runs left for this target, once the typing pauses.
  useEffect(() => {
    const target = scope.trim();
    setMemory(null);
    if (!target) return;
    let live = true;
    const t = setTimeout(() => { reconMemoryGet(target).then((m) => { if (live) setMemory(m); }).catch(() => {}); }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [scope]);

  // The logged-in session held for this target; while a pairing code is out, watch for the extension's post.
  useEffect(() => {
    const target = scope.trim();
    setSession(null);
    setPairing(null);
    if (!target) return;
    let live = true;
    const t = setTimeout(() => { reconSessionGet(target).then((s) => { if (live) setSession(s); }).catch(() => {}); }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [scope]);
  useEffect(() => {
    if (!pairing) return;
    const target = scope.trim();
    const had = session?.capturedAt ?? 0;
    const t = setInterval(() => {
      if (Date.now() > pairing.expiresAt) return setPairing(null);
      reconSessionGet(target).then((s) => { if (s && s.capturedAt > had) { setSession(s); setUseSession(true); setPairing(null); } }).catch(() => {});
    }, 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart only when a new code is issued
  }, [pairing]);

  async function pair() {
    setError(null);
    try { setPairing(await reconSessionPair(scope.trim())); } catch (e) { setError((e as Error).message); }
  }
  async function forgetSession() {
    setError(null);
    try { await reconSessionForget(scope.trim()); setSession(null); } catch (e) { setError((e as Error).message); }
  }

  async function forget() {
    if (!memory) return;
    setError(null);
    try {
      await reconMemoryForget(scope.trim());
      setMemory(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const ready = scope.trim() && objective.trim() && divergences.trim() && authorised && !busy;
  async function start() {
    setBusy(true); setError(null);
    try {
      const nonProdSettings = settings.split(",").map((s) => s.trim()).filter(Boolean);
      await onStart({
        scope: scope.trim(), objective: objective.trim(),
        env: { kind, divergences: divergences.trim(), ...(nonProdSettings.length ? { nonProdSettings } : {}) },
        chainPass: { enabled: chain },
        useMemory: Boolean(memory) && useMemory,
        useSession: Boolean(session) && useSession,
        ...(retest && memory?.findings ? { mode: "retest" as const } : {}),
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
      {scope.trim() && (
        <div className="recon-session">
          {session ? (
            <label className="recon-consent recon-option">
              <input type="checkbox" checked={useSession} onChange={(e) => setUseSession(e.target.checked)} />
              <span>
                Test logged in, with the session {sessionSummary(session)}.{" "}
                <button type="button" className="btn-link" disabled={busy} onClick={(e) => { e.preventDefault(); void pair(); }}>capture again</button>{" · "}
                <button type="button" className="btn-link" disabled={busy} onClick={(e) => { e.preventDefault(); void forgetSession(); }}>forget</button>
              </span>
            </label>
          ) : (
            <div className="hint">
              No logged-in session for this target: the run tests what answers without an account.{" "}
              <button type="button" className="btn-link" disabled={busy} onClick={() => void pair()}>capture one from your browser</button>
            </div>
          )}
          {pairing && (
            <div className="recon-pairing">
              <div>
                1. Install the extension once: <a href="/api/agent/recon/extension.zip">download</a>, unzip, then in
                Chrome or Edge open <span className="mono">chrome://extensions</span>, turn on Developer mode and choose Load unpacked.
              </div>
              <div>2. Open the target in a tab and log in yourself, 2FA included. Use a test account.</div>
              <div>3. Click the extension, paste this code and press send. It works once, for this target, for ten minutes.</div>
              <input type="text" className="mono" readOnly value={pairing.token} aria-label="Pairing code" onFocus={(e) => e.target.select()} />
              <div className="hint">Waiting for the extension…</div>
            </div>
          )}
        </div>
      )}
      {memory && (
        <label className="recon-consent recon-option">
          <input type="checkbox" checked={useMemory} onChange={(e) => setUseMemory(e.target.checked)} />
          <span>
            Start from what is remembered about this target: {memorySummary(memory)}. Each is re-tested before it counts.{" "}
            <button type="button" className="btn-link" disabled={busy} onClick={(e) => { e.preventDefault(); void forget(); }}>forget this target</button>
          </span>
        </label>
      )}
      {memory && memory.findings > 0 && (
        <label className="recon-consent recon-option">
          <input type="checkbox" checked={retest} onChange={(e) => setRetest(e.target.checked)} />
          <span>
            Retest only: re-check the {memory.findings} remembered finding{memory.findings === 1 ? "" : "s"} and say which
            still reproduce and which are fixed. Nothing new is explored, and no attack paths are looked for.
          </span>
        </label>
      )}
      <label className="recon-consent recon-option">
        <input type="checkbox" checked={chain} onChange={(e) => setChain(e.target.checked)} />
        <span>
          Look for attack paths afterwards: with two or more findings, try to combine them and show each path end to end.
          Same approvals, same target; up to 15% of the token budget is kept for it.
        </span>
      </label>
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
      <span>{progressLabel(recon)}</span>
      <span>{formatTokens(recon.tokens)}/{formatTokens(recon.budgetTokens)} tokens</span>
      {running && recon.model && <span title={`profile ${recon.profile}`}>{recon.model}</span>}
      <span title="Approvals the gate answered itself, and the ones it left for you">
        auto-allowed {recon.gate.allowed} · asked {recon.gate.asked} · blocked {recon.gate.denied}
      </span>
      {running
        ? <button className="btn sm danger-outline" onClick={onStop}>stop</button>
        : (
          <>
            <span className="recon-end">ended: {retestStopReason(recon) ?? (recon.stopped ? STOP_REASON[recon.stopped] : "finished")}</span>
            <button className="link-btn" onClick={onDismiss}>dismiss</button>
          </>
        )}
    </div>
  );
}

/**
 * What the verifier confirmed: attack paths first (they are the worst of it), then the
 * findings, then the paths that could not be shown. All of this is model output about
 * the target: shown as plain text.
 */
export function ReconFindings({ recon }: { recon: ReconState }) {
  if (recon.mode === "retest") return <RetestResults recon={recon} />;
  if (recon.status === "running" && !recon.findings.length) return null;
  const { demonstrated, partial } = splitPaths(recon.chains);
  const chaining = recon.status === "running" && recon.phase === "chains";
  const note = chainPassNote(recon);
  const from = memoryNote(recon);
  const loggedIn = sessionNote(recon);
  const kept = keptNote(recon);
  return (
    <div className="recon-findings">
      {loggedIn && <div className="hint recon-from">{loggedIn}</div>}
      {from && <div className="hint recon-from">{from}</div>}
      {(demonstrated.length > 0 || chaining) && (
        <div className="recon-section">
          <div className="perm-title recon-title">Attack paths ({demonstrated.length})</div>
          {chaining && <div className="hint">Combining the findings into attack paths and trying each one…</div>}
          {demonstrated.map((c, i) => <ChainCard key={c.id ?? i} c={c} />)}
        </div>
      )}
      <div className="recon-section">
        <div className="perm-title recon-title">
          Recon findings ({recon.findings.length}) · {recon.env.kind}
        </div>
        {recon.error && <div className="hint danger">{recon.error}</div>}
        {!recon.findings.length && <div className="hint">The verifier confirmed no findings in this run.</div>}
        {recon.findings.map((f, i) => <FindingCard key={f.id ?? i} f={f} paths={pathsUsing(f.id, recon.chains)} />)}
      </div>
      {partial.length > 0 && (
        <div className="recon-section">
          <div className="perm-title recon-title recon-title-lead">Unproven paths ({partial.length})</div>
          <div className="hint">Leads, not findings: each stopped before it was shown end to end.</div>
          {partial.map((c, i) => <ChainCard key={c.id ?? i} c={c} />)}
        </div>
      )}
      {note && <div className="hint recon-note">{note}</div>}
      {kept && <div className="hint recon-note">{kept}</div>}
    </div>
  );
}

/** A retest run: each remembered finding with the verifier's ruling on it now. */
function RetestResults({ recon }: { recon: ReconState }) {
  const retests = recon.retests ?? [];
  if (recon.status === "running" && !retests.length) return null;
  const loggedIn = sessionNote(recon);
  const kept = keptNote(recon);
  return (
    <div className="recon-findings">
      {loggedIn && <div className="hint recon-from">{loggedIn}</div>}
      <div className="recon-section">
        <div className="perm-title recon-title">Retest · {retestSummary(retests)} · {recon.env.kind}</div>
        {recon.error && <div className="hint danger">{recon.error}</div>}
        {retests.map((r, i) => <RetestCard key={i} r={r} />)}
      </div>
      {kept && <div className="hint recon-note">{kept}</div>}
    </div>
  );
}

function ProofBadge({ proof }: { proof: ReconFinding["proof"] }) {
  const b = proofBadge(proof);
  return b ? <span className={`badge proof-${b.kind}`} title={b.title}>{b.text}</span> : null;
}

function RetestCard({ r }: { r: ReconRetest }) {
  return (
    <div className={`recon-finding recon-retest ${r.result}`}>
      <div className="recon-finding-head">
        <span className={`badge retest-${r.result}`}>{RETEST_LABEL[r.result]}</span>
        <span className={`badge sev-${r.severity}`}>{r.severity}</span>
        <span className="recon-finding-title">{r.title}</span>
        {r.standardId && <span className="badge">{r.standardId}</span>}
        <ProofBadge proof={r.proof} />
        <span className="recon-in-paths">last verified {new Date(r.lastVerified).toISOString().slice(0, 10)}</span>
      </div>
      {r.note && <div className="hint">{r.note}</div>}
      {r.evidence && <pre className="recon-repro">{r.evidence}</pre>}
    </div>
  );
}

/** One attack path: what it reaches, the findings it uses, and its steps with their evidence. */
function ChainCard({ c }: { c: ReconChain }) {
  const partial = c.status === "partial";
  return (
    <div className={"recon-finding recon-chain" + (partial ? " partial" : "")}>
      <div className="recon-finding-head">
        {c.id && <span className="badge recon-id">{c.id}</span>}
        <span className={`badge sev-${c.severity}`} title={partial ? "The worst this path could be: it was not shown" : undefined}>
          {partial ? `up to ${c.severity}` : c.severity}
        </span>
        <span className="recon-finding-title">{c.title}</span>
        {c.standardId && <span className="badge">{c.standardId}</span>}
        {c.verdict === "config-dependent" && <span className="badge sev-medium">config-dependent</span>}
      </div>
      <div className="recon-impact">{c.impact}</div>
      <div className="recon-links">
        <span>uses</span>
        {c.links.map((id) => <span className="badge recon-id" key={id}>{id}</span>)}
      </div>
      {partial && <div className="hint recon-stopped">{stoppedAt(c)}</div>}
      <ol className="recon-steps">
        {c.steps.map((s, i) => (
          <li key={i} className={partial && c.blockedAt === i + 1 ? "blocked" : undefined}>
            <div>{s.action}</div>
            {s.evidence && <pre className="recon-repro">{s.evidence}</pre>}
          </li>
        ))}
      </ol>
      {c.prodCaveat && <div className="hint">Re-test against production: {c.prodCaveat}</div>}
    </div>
  );
}

function FindingCard({ f, paths }: { f: ReconFinding; paths: string[] }) {
  return (
    <div className="recon-finding">
      <div className="recon-finding-head">
        {f.id && <span className="badge recon-id">{f.id}</span>}
        <span className={`badge sev-${f.severity}`}>{f.severity}</span>
        <span className="recon-finding-title">{f.title}</span>
        {f.standardId && <span className="badge">{f.standardId}</span>}
        {f.verdict === "config-dependent" && <span className="badge sev-medium">config-dependent</span>}
        <ProofBadge proof={f.proof} />
        {paths.length > 0 && <span className="recon-in-paths" title="Attack paths that build on this finding">in {paths.join(", ")}</span>}
      </div>
      <pre className="recon-repro">{f.repro}</pre>
      {f.prodCaveat && <div className="hint">Re-test against production: {f.prodCaveat}</div>}
    </div>
  );
}
