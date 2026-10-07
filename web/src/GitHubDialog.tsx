/**
 * "github --clone": sign in to the BugXHunter GitHub App (device flow: a
 * short code typed on GitHub, nothing to register), pick one of the
 * repositories the app was installed on and clone it (or fast-forward it)
 * into the workspace, then open it as the project. Read-only by construction:
 * the runner holds the token, the agent gets a working copy with no credentials.
 * See shared/github.d.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "./Dialog";
import { GitBranchIcon, GitHubIcon } from "./icons";
import {
  ago, githubBranches, githubClone, githubConnectPoll, githubConnectStart, githubDisconnect, githubRepos, githubStatus,
  type DeviceStart, type GitHubBranch, type GitHubRepo, type GitHubStatus,
} from "./github";

export function GitHubDialog({ onOpen, onClose }: { onOpen: (dir: string) => void; onClose: () => void }) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [repos, setRepos] = useState<GitHubRepo[] | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<GitHubRepo | null>(null);
  const [branches, setBranches] = useState<GitHubBranch[] | null>(null);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState<"repos" | "branches" | "clone" | "connect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceStart | null>(null);
  const [copied, setCopied] = useState(false);

  const refreshStatus = useCallback(() => githubStatus().then((s) => { setStatus(s); setStatusError(null); }).catch((e) => setStatusError((e as Error).message)), []);
  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const usable = Boolean(status?.connected && !status.sealed && !status.error);
  const loadRepos = useCallback(() => {
    setBusy("repos");
    githubRepos().then(setRepos).catch((e) => setError((e as Error).message)).finally(() => setBusy((b) => (b === "repos" ? null : b)));
  }, []);
  useEffect(() => { if (usable) loadRepos(); }, [usable, loadRepos]);

  // The install screen opens in another tab; re-read when this one is back
  // in front, so a repository just granted shows up without a reload.
  useEffect(() => {
    if (!usable) return;
    const onFocus = () => loadRepos();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [usable, loadRepos]);

  // --- sign-in (device flow) ------------------------------------------------------
  const pollTimer = useRef<number | null>(null);
  const stopPolling = () => { if (pollTimer.current) { window.clearTimeout(pollTimer.current); pollTimer.current = null; } };
  useEffect(() => stopPolling, []);

  async function connect() {
    setBusy("connect"); setError(null);
    try {
      const d = await githubConnectStart();
      setDevice(d);
      try { await navigator.clipboard.writeText(d.userCode); setCopied(true); } catch { setCopied(false); }
      const tick = async () => {
        try {
          const r = await githubConnectPoll(d.id);
          if (r.status === "pending") { pollTimer.current = window.setTimeout(tick, d.interval * 1000); return; }
          setDevice(null); setBusy(null);
          if (r.status === "connected") { await refreshStatus(); return; }
          setError(r.status === "denied" ? "The sign-in was cancelled on GitHub." : "The code expired. Start again.");
        } catch (e) {
          setDevice(null); setBusy(null); setError((e as Error).message);
        }
      };
      pollTimer.current = window.setTimeout(tick, d.interval * 1000);
    } catch (e) {
      setBusy(null); setError((e as Error).message);
    }
  }
  function cancelConnect() { stopPolling(); setDevice(null); setBusy(null); }
  async function disconnect() {
    setError(null);
    try { await githubDisconnect(); setRepos(null); setSelected(null); await refreshStatus(); } catch (e) { setError((e as Error).message); }
  }

  // --- repository, branch, clone ---------------------------------------------------
  function pick(repo: GitHubRepo) {
    setSelected(repo); setBranch(repo.defaultBranch); setBranches(null); setError(null); setBusy("branches");
    githubBranches(repo.fullName)
      .then((b) => { setBranches(b); if (!b.some((x) => x.name === repo.defaultBranch) && b[0]) setBranch(b[0].name); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy((b) => (b === "branches" ? null : b)));
  }

  async function clone() {
    if (!selected) return;
    setBusy("clone"); setError(null);
    try {
      const r = await githubClone({ repo: selected.fullName, branch });
      onOpen(r.directory);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (repos ?? []).filter((r) => !q || r.fullName.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q));
  }, [repos, filter]);

  return (
    <Dialog title="github --clone" onClose={onClose}>
      {statusError && <div className="hint danger">{statusError}</div>}

      {status && !status.connected && !device && (
        <>
          <p>Clone a repository into the workspace so the agent can review it. <b>Read-only</b>: the app can only read
            code, it reaches only the repositories you install it on, and nothing in the sandbox can push.</p>
          <div className="perm-actions center">
            <button className="btn primary wide" disabled={busy !== null} onClick={connect}><GitHubIcon size={15} /> {busy === "connect" ? "contacting GitHub…" : "Connect GitHub"}</button>
          </div>
          {status.storage === "memory" && <div className="hint" style={{ textAlign: "center" }}>No vault yet, so the sign-in is kept until the runner restarts. Set up the vault to keep it.</div>}
        </>
      )}

      {device && (
        <>
          <p>Enter this code on GitHub to connect. {copied ? "It is on your clipboard." : "Click it to copy."}</p>
          <button className="recovery-code gh-code" onClick={() => navigator.clipboard.writeText(device.userCode).then(() => setCopied(true)).catch(() => {})} title="Copy">{device.userCode}</button>
          <div className="perm-actions center">
            <a className="btn primary wide" href={device.verificationUri} target="_blank" rel="noreferrer">Open github.com/login/device ↗</a>
          </div>
          <div className="hint" style={{ textAlign: "center" }}>Waiting for your approval… this finishes by itself. <button className="link-btn" onClick={cancelConnect}>cancel</button></div>
        </>
      )}

      {status?.sealed && <p>Your GitHub sign-in is in the vault, which is locked. Unlock it (the lock icon below) and reopen this dialog.</p>}
      {status?.error && <div className="hint danger">{status.error}</div>}

      {usable && (
        <>
          <div className="gh-head">
            <span>
              connected as <b>{status!.login}</b>{status!.storage === "memory" ? " · until restart (no vault yet)" : ""} · <button className="link-btn" onClick={disconnect}>disconnect</button>
            </span>
            <a href={status!.installUrl} target="_blank" rel="noreferrer">choose repositories on GitHub ↗</a>
          </div>
          {status!.clones.length > 0 && (
            <>
              <div className="section-title">in the workspace</div>
              <div className="vault-items">
                {status!.clones.map((c) => (
                  <div className="vault-item" key={c.directory}>
                    <span className="ok" aria-hidden>✓</span>
                    <span className="name" title={c.directory}>{c.fullName}<span className="desc"> — {c.branch ?? "detached"}</span></span>
                    <button className="btn sm" onClick={() => { onOpen(c.directory); onClose(); }}>open</button>
                  </div>
                ))}
              </div>
            </>
          )}

          {repos && repos.length === 0 ? (
            <div className="gh-callout">
              <b>One more step.</b> Signing in says who you are; which repositories BugXHunter may read is chosen separately,
              on GitHub's install screen. An organisation's owner may have to approve it. This list refreshes when you come back.
              <div className="perm-actions center">
                <a className="btn primary wide" href={status!.installUrl} target="_blank" rel="noreferrer">Choose repositories on GitHub ↗</a>
              </div>
            </div>
          ) : (
            <>
              <input type="text" className="mono" placeholder="filter repositories…" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} autoFocus />
              <div className="gh-list" role="listbox" aria-label="Repositories">
                {busy === "repos" && !repos && <div className="hint">loading…</div>}
                {repos && repos.length > 0 && shown.length === 0 && <div className="hint">Nothing matches.</div>}
                {shown.map((r) => (
                  <button key={r.fullName} className={`gh-repo${selected?.fullName === r.fullName ? " selected" : ""}`} role="option" aria-selected={selected?.fullName === r.fullName} onClick={() => pick(r)}>
                    <span className="gh-name">
                      {r.fullName}
                      {r.private && <span className="badge">private</span>}
                      {r.archived && <span className="badge">archived</span>}
                      {r.directory && <span className="badge on">in workspace</span>}
                    </span>
                    {r.description && <span className="gh-desc">{r.description}</span>}
                    <span className="gh-meta"><GitBranchIcon size={11} /> {r.defaultBranch}{r.pushedAt ? ` · pushed ${ago(r.pushedAt)}` : ""}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {selected && (
            <div className="gh-clone">
              <label htmlFor="gh-branch">Branch</label>
              <select id="gh-branch" className="mono" value={branch} onChange={(e) => setBranch(e.target.value)} disabled={!branches}>
                {(branches ?? [{ name: branch, isDefault: true }]).map((b) => <option key={b.name} value={b.name}>{b.name}{b.isDefault ? " (default)" : ""}</option>)}
              </select>
              <button className="btn primary sm" disabled={busy !== null || !branch} onClick={clone}>
                {busy === "clone" ? (selected.directory ? "updating…" : "cloning…") : selected.directory ? "update & open" : "clone & open"}
              </button>
            </div>
          )}
          {selected && <div className="hint">Lands in <span className="mono">{status!.cloneRoot}/{selected.fullName}</span>. An existing clone is fast-forwarded, never reset; the agent's local edits stay.</div>}
        </>
      )}
      {error && <div className="hint danger">{error}</div>}
    </Dialog>
  );
}
