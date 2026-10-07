/**
 * "github --clone": pick one of the repositories the token was granted and
 * clone it (or fast-forward it) into the workspace, then open it as the
 * project. Read-only by construction: the runner holds the token, the agent
 * gets a working copy with no credentials. See shared/github.d.ts.
 */
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "./Dialog";
import { GitBranchIcon } from "./icons";
import { ago, githubBranches, githubClone, githubRepos, githubStatus, NEW_TOKEN_URL, TOKENS_URL, type GitHubBranch, type GitHubRepo, type GitHubStatus } from "./github";

export function GitHubDialog({ onOpen, onClose }: { onOpen: (dir: string) => void; onClose: () => void }) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [repos, setRepos] = useState<GitHubRepo[] | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<GitHubRepo | null>(null);
  const [branches, setBranches] = useState<GitHubBranch[] | null>(null);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState<"repos" | "branches" | "clone" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    githubStatus().then(setStatus).catch((e) => setStatusError((e as Error).message));
  }, []);

  const usable = Boolean(status?.configured && !status.sealed && !status.error);
  useEffect(() => {
    if (!usable) return;
    setBusy("repos");
    githubRepos().then(setRepos).catch((e) => setError((e as Error).message)).finally(() => setBusy(null));
  }, [usable]);

  function pick(repo: GitHubRepo) {
    setSelected(repo);
    setBranch(repo.defaultBranch);
    setBranches(null);
    setError(null);
    setBusy("branches");
    githubBranches(repo.fullName)
      .then((b) => { setBranches(b); if (!b.some((x) => x.name === repo.defaultBranch) && b[0]) setBranch(b[0].name); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy((b) => (b === "branches" ? null : b)));
  }

  async function clone() {
    if (!selected) return;
    setBusy("clone");
    setError(null);
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
      {status && !status.configured && (
        <>
          <p>Clone a repository into the workspace so the agent can review it. <b>Read-only</b>: the runner clones and
            fetches with your token, the agent only ever sees the working copy, and nothing here can push.</p>
          <p>You choose the reach on GitHub when you create the token:</p>
          <ol className="gh-steps">
            <li><a href={NEW_TOKEN_URL} target="_blank" rel="noreferrer">Create a fine-grained token</a> — Repository access: <b>Only select repositories</b>; Permissions: <b>Contents: Read-only</b> (Metadata comes with it).</li>
            <li>Add it to the vault as <span className="mono">GITHUB_TOKEN</span> (the keys dialog below, left of the lock).</li>
          </ol>
          <p>Nothing else is needed: no GitHub App, no callback URL. Repositories can be added to or removed from the token on GitHub at any time.</p>
        </>
      )}
      {status?.sealed && <p>The token is in the vault, which is locked. Unlock it (the lock icon below) and reopen this dialog.</p>}
      {status?.error && <div className="hint danger">{status.error}</div>}

      {usable && (
        <>
          <div className="gh-head">
            <span>connected as <b>{status!.login}</b> · token from {status!.source === "vault" ? "the vault" : ".env"}</span>
            <a href={TOKENS_URL} target="_blank" rel="noreferrer">choose repositories on GitHub ↗</a>
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

          <input type="text" className="mono" placeholder="filter repositories…" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} autoFocus />
          <div className="gh-list" role="listbox" aria-label="Repositories">
            {busy === "repos" && <div className="hint">loading…</div>}
            {repos && repos.length === 0 && <div className="hint">The token reaches no repositories yet. Add some on GitHub, then reopen this dialog.</div>}
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
