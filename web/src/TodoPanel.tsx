import { useState } from "react";
import type { Todo } from "./agentApi";

const ICON: Record<string, string> = { completed: "✓", in_progress: "◐", pending: "○", cancelled: "✕" };

/** The agent's own task list (OpenCode's todowrite tool), updated live. */
export function TodoPanel({ todos }: { todos: Todo[] }) {
  const [open, setOpen] = useState(true);
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress");
  return (
    <div className="todo-panel">
      <button className="todo-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={"chev" + (open ? " open" : "")}>›</span>
        <span className="todo-title">Tasks</span>
        <span className="todo-count">{done}/{todos.length}</span>
        <span className="todo-bar"><span style={{ width: `${(done / todos.length) * 100}%` }} /></span>
        {!open && current && <span className="todo-current">{current.content}</span>}
      </button>
      {open && (
        <ul className="todo-list">
          {todos.map((t, i) => (
            <li key={i} className={"todo s-" + t.status}>
              <span className="todo-icon" aria-hidden>{ICON[t.status] ?? "○"}</span>
              <span className="todo-text">{t.content}</span>
              {t.priority === "high" && t.status !== "completed" && <span className="todo-prio">high</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
