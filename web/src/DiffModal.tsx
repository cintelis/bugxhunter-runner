/** The "Changes" modal: every file the agent edited this session, as a diff. */
import { useEffect, useMemo, useState } from "react";
import type { FileDiff } from "./agentApi";
import { lineDiff, patchLines, withContext } from "./diff";

export function DiffModal({ diff, onClose }: { diff: FileDiff[] | string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title"><span className="dot r" aria-hidden />git diff --session</span>
          <button className="btn ghost sm" onClick={onClose}>close</button>
        </div>
        <div className="modal-body">
          {typeof diff === "string" ? <pre className="diff-raw">{diff}</pre>
            : diff.length === 0 ? (
              <p className="muted">
                No changes recorded. OpenCode tracks changes only in git repositories — run <code className="mono">git init</code> in
                the project folder to see them here.
              </p>
            )
            : diff.map((f, i) => <FileDiffView key={`${f.turn ?? 0}-${f.file}-${i}`} f={f} />)}
        </div>
      </div>
    </div>
  );
}

function FileDiffView({ f }: { f: FileDiff }) {
  const [open, setOpen] = useState(true);
  const lines = useMemo(
    () => (f.patch !== undefined ? patchLines(f.patch) : withContext(lineDiff(f.before ?? "", f.after ?? ""))),
    [f.patch, f.before, f.after],
  );
  return (
    <div className="file-diff">
      <button className="file-diff-head" onClick={() => setOpen((v) => !v)}>
        <span className={"chev" + (open ? " open" : "")}>›</span>
        <span className="mono">{f.file}</span>
        {f.turn ? <span className="muted turn">prompt {f.turn}</span> : null}
        <span className="adds">+{f.additions ?? 0}</span>
        <span className="dels">−{f.deletions ?? 0}</span>
      </button>
      {open && (
        <pre className="diff-lines">
          {lines.map((l, i) =>
            l === null ? <div key={i} className="dl gap">⋯</div>
            : <div key={i} className={"dl " + l.kind}>{l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}{l.text}</div>,
          )}
        </pre>
      )}
    </div>
  );
}
