/** The terminal-window modal the vault and GitHub dialogs share: Esc or the ✕ closes it. */
import { useEffect, type ReactNode } from "react";

export function Dialog({ title, onClose, children }: { title: string; onClose?: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay vault-dialog" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title"><span className="dot y" aria-hidden />{title}</span>
          {onClose && <button className="icon-btn close-x" onClick={onClose} aria-label="Close" title="Close (Esc)">✕</button>}
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
