/**
 * "workspace --list": the folders under the workspace root (/workspace in
 * Docker, ~/bugxhunter/repos locally), where GitHub clones land too. Open one
 * as the project, create a new one (a git repository), or delete one. A
 * delete asks for the name typed back, and the open project cannot be deleted.
 */
import { useCallback, useEffect, useState } from "react";
import { Dialog } from "./Dialog";
import { FolderIcon, PlusIcon, TrashIcon } from "./icons";
import { ago } from "./github";
import { createWorkspace, deleteWorkspace, listWorkspaces, type Workspace } from "./agentApi";

export function WorkspacesDialog({ current, onOpen, onDeleted, onClose }: { current: string; onOpen: (dir: string) => void; onDeleted: (dir: string) => void; onClose: () => void }) {
  const [root, setRoot] = useState("");
  const [list, setList] = useState<Workspace[] | null>(null);
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState<Workspace | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => listWorkspaces().then((l) => { setRoot(l.root); setList(l.workspaces); }).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { refresh(); }, [refresh]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const create = () => run(async () => {
    const ws = await createWorkspace(name.trim());
    setName("");
    onOpen(ws.directory);
    onClose();
  });
  const remove = (ws: Workspace) => run(async () => {
    await deleteWorkspace(ws.directory);
    onDeleted(ws.directory);
    setConfirming(null); setTyped("");
    await refresh();
  });

  return (
    <Dialog title="workspace --list" onClose={onClose}>
      <p>Each workspace is a folder the agent works in{root ? <> under <span className="mono">{root}</span></> : null}. Repositories cloned from GitHub appear here too.</p>

      <div className="ws-new">
        <input type="text" className="mono" placeholder="new-workspace-name" aria-label="New workspace name" value={name} spellCheck={false}
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) create(); }} />
        <button className="btn primary sm" disabled={busy || !name.trim()} onClick={create}><PlusIcon size={13} /> create</button>
      </div>

      <div className="gh-list" role="list">
        {!list && !error && <div className="hint">loading…</div>}
        {list && list.length === 0 && <div className="hint">No workspaces yet. Create one above, or clone a repository from GitHub.</div>}
        {list?.map((ws) => {
          const open = ws.directory === current;
          return (
            <div key={ws.directory} className={`ws-row${open ? " current" : ""}`} role="listitem">
              <button className="ws-open" onClick={() => { onOpen(ws.directory); onClose(); }} disabled={open} title={open ? "This is the open project" : `Open ${ws.directory}`}>
                <FolderIcon size={14} />
                <span className="gh-name">{ws.name}{open && <span className="badge on">open</span>}{!ws.git && <span className="badge">no git</span>}</span>
                <span className="gh-meta">{ws.modified ? `changed ${ago(ws.modified)}` : ""}</span>
              </button>
              <button className="icon-btn ws-del" disabled={busy || open} onClick={() => { setConfirming(ws); setTyped(""); }}
                title={open ? "Open another project before deleting this one" : `Delete ${ws.name}`} aria-label={`Delete ${ws.name}`}>
                <TrashIcon size={14} />
              </button>
            </div>
          );
        })}
      </div>

      {confirming && (
        <div className="ws-confirm">
          <p><b>Delete {confirming.name}?</b> Everything in <span className="mono">{confirming.directory}</span> is removed, including work the agent has not pushed anywhere. Type the name to confirm.</p>
          <div className="ws-new">
            <input type="text" className="mono" autoFocus placeholder={confirming.name} aria-label="Type the workspace name to confirm" value={typed} spellCheck={false}
              onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && typed === confirming.name) remove(confirming); }} />
            <button className="btn danger-outline sm" disabled={busy || typed !== confirming.name} onClick={() => remove(confirming)}>{busy ? "deleting…" : "delete"}</button>
            <button className="btn sm" disabled={busy} onClick={() => setConfirming(null)}>cancel</button>
          </div>
        </div>
      )}
      {error && <div className="hint danger">{error}</div>}
    </Dialog>
  );
}
