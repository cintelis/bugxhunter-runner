/**
 * "files --browse": the open project's files. Folders open in place, a file
 * downloads with one click, and files are uploaded into the folder on show,
 * with the button or by dropping them on the list. An upload never replaces
 * a file: a clash is saved as name-1.ext and the list says so.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { Dialog } from "./Dialog";
import { DownloadIcon, FileIcon, FolderIcon, UpIcon, UploadIcon } from "./icons";
import { ago } from "./github";
import { formatBytes } from "./format";
import { listProjectFiles, projectFileUrl, uploadProjectFile, type ProjectListing } from "./agentApi";

export function FilesDialog({ directory, onClose }: { directory: string; onClose: () => void }) {
  const [sub, setSub] = useState("");
  const [listing, setListing] = useState<ProjectListing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback((path: string) => {
    setError(null);
    listProjectFiles(directory, path).then((l) => { setListing(l); setSub(l.path); }).catch((e) => setError((e as Error).message));
  }, [directory]);
  useEffect(() => { load(""); }, [load]);

  async function upload(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setError(null);
    const done: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      setBusy(`uploading ${i + 1} of ${list.length}: ${f.name}`);
      try {
        const r = await uploadProjectFile(directory, sub, f);
        done.push(r.name === f.name ? `${r.path} (${formatBytes(r.bytes)})` : `${f.name} → ${r.path}, as a file of that name exists`);
      } catch (e) {
        done.push(`${f.name}: ${(e as Error).message}`);
      }
    }
    setBusy(null);
    setNotes(done);
    load(sub);
  }

  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); };
  const crumbs = sub ? sub.split("/") : [];
  const project = directory.split(/[\\/]/).filter(Boolean).pop() ?? directory;

  return (
    <Dialog title="files --browse" onClose={onClose}>
      <div className="files-head">
        <nav className="files-crumbs mono" aria-label="Folder">
          <button className="link-btn" onClick={() => load("")} title={directory}>{project}</button>
          {crumbs.map((c, i) => (
            <span key={i}>
              <span className="sep">/</span>
              <button className="link-btn" onClick={() => load(crumbs.slice(0, i + 1).join("/"))}>{c}</button>
            </span>
          ))}
        </nav>
        <button className="btn primary sm" disabled={!!busy} onClick={() => input.current?.click()}><UploadIcon size={13} /> upload</button>
        <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ""; }} />
      </div>

      <div className={`gh-list files-list${dragging ? " dragging" : ""}`} role="list"
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
        {!listing && !error && <div className="hint">loading…</div>}
        {sub && (
          <button className="file-row" onClick={() => load(crumbs.slice(0, -1).join("/"))}>
            <UpIcon size={14} /><span className="file-name">..</span>
          </button>
        )}
        {listing && listing.entries.length === 0 && <div className="hint">Empty. Drop files here, or use upload.</div>}
        {listing?.entries.map((e) => {
          const rel = sub ? `${sub}/${e.name}` : e.name;
          return e.type === "dir" ? (
            <button key={e.name} className="file-row" onClick={() => load(rel)}>
              <FolderIcon size={14} /><span className="file-name">{e.name}/</span>
              <span className="gh-meta">{e.modified ? ago(e.modified) : ""}</span>
            </button>
          ) : (
            <a key={e.name} className="file-row" href={projectFileUrl(directory, rel)} download={e.name} title={`Download ${rel}`}>
              <FileIcon size={14} /><span className="file-name">{e.name}</span>
              <span className="gh-meta">{formatBytes(e.size)}{e.modified ? ` · ${ago(e.modified)}` : ""}</span>
              <DownloadIcon size={13} className="file-dl" />
            </a>
          );
        })}
        {listing?.truncated && <div className="hint">Showing the first 2000 entries.</div>}
      </div>

      <div className="hint">{busy ?? "Click a file to download it. Drop files on the list to upload them into this folder; nothing is overwritten."}</div>
      {notes.length > 0 && (
        <ul className="files-notes">{notes.map((n, i) => <li key={i} className="mono">{n}</li>)}</ul>
      )}
      {error && <div className="hint danger">{error}</div>}
    </Dialog>
  );
}
