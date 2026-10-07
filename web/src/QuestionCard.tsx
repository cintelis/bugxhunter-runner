/** The agent's multiple-choice question(s): pick options and/or type an answer, then send. */
import { useState } from "react";
import type { AgentQuestion } from "./agentApi";

export interface QuestionReq {
  requestID: string;
  questions: AgentQuestion[];
}

export function QuestionCard({ req, onAnswer, onDismiss }: {
  req: QuestionReq; onAnswer: (answers: string[][]) => void; onDismiss: () => void;
}) {
  const [picked, setPicked] = useState<string[][]>(() => req.questions.map(() => []));
  const [typed, setTyped] = useState<string[]>(() => req.questions.map(() => ""));

  function toggle(qi: number, label: string, multiple?: boolean) {
    setPicked((cur) => cur.map((sel, i) => {
      if (i !== qi) return sel;
      if (!multiple) return sel[0] === label ? [] : [label];
      return sel.includes(label) ? sel.filter((l) => l !== label) : [...sel, label];
    }));
    // A single-choice pick replaces a typed answer.
    if (!multiple) setTyped((cur) => cur.map((t, i) => (i === qi ? "" : t)));
  }

  const answers = req.questions.map((q, i) => {
    const own = typed[i].trim();
    if (!q.multiple && own) return [own];
    return own ? [...picked[i], own] : picked[i];
  });
  const complete = answers.every((a) => a.length > 0);

  return (
    <div className="question-card">
      <div className="perm-title">The agent has a question</div>
      {req.questions.map((q, qi) => (
        <div className="q-block" key={qi}>
          {q.header && <span className="q-header">{q.header}</span>}
          <div className="q-text">{q.question}</div>
          {q.multiple && <div className="hint" style={{ marginTop: 0 }}>Choose any that apply.</div>}
          <div className="q-options" role={q.multiple ? "group" : "radiogroup"}>
            {q.options.map((o) => {
              const on = picked[qi].includes(o.label);
              return (
                <button
                  key={o.label}
                  className={"q-option" + (on ? " on" : "")}
                  role={q.multiple ? "checkbox" : "radio"}
                  aria-checked={on}
                  onClick={() => toggle(qi, o.label, q.multiple)}
                >
                  <span className={"q-mark" + (q.multiple ? " box" : "")} aria-hidden>{on ? "✓" : ""}</span>
                  <span className="q-label">{o.label}</span>
                  {o.description && <span className="q-desc">{o.description}</span>}
                </button>
              );
            })}
          </div>
          {q.custom !== false && (
            <input
              type="text"
              className="q-custom"
              placeholder="Or type your own answer…"
              value={typed[qi]}
              onChange={(e) => {
                const v = e.target.value;
                setTyped((cur) => cur.map((t, i) => (i === qi ? v : t)));
                if (!q.multiple && v.trim()) setPicked((cur) => cur.map((s, i) => (i === qi ? [] : s)));
              }}
              onKeyDown={(e) => { if (e.key === "Enter" && complete) onAnswer(answers); }}
            />
          )}
        </div>
      ))}
      <div className="perm-actions">
        <button className="btn primary sm" disabled={!complete} onClick={() => onAnswer(answers)}>Send answer</button>
        <button className="btn sm" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}
