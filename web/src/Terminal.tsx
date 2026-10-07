/**
 * Terminal-window chrome shared by the Runner, the Playground and the login
 * screen: a macOS-style title bar with traffic-light dots, and the typewriter
 * "boot sequence" from bugxhunter.com's hero.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";

/** Title bar: ● ● ●  user@host: ~/path   [actions] */
export function TerminalBar({ title, tooltip, children }: { title: string; tooltip?: string; children?: ReactNode }) {
  return (
    <header className="term-bar">
      <span className="dot r" aria-hidden /><span className="dot y" aria-hidden /><span className="dot g" aria-hidden />
      <span className="term-title" title={tooltip ?? title}>{title}</span>
      {children && <div className="head-actions">{children}</div>}
    </header>
  );
}

export interface BootLine {
  /** `p` = shell prompt ($), `out` = progress ([*]), `ok` = success ([+]). */
  kind: "p" | "out" | "ok";
  text: string;
  /** Trailing status word shown once the line is typed, e.g. "OK". */
  ok?: string;
  /** ms per character. */
  pace?: number;
}

const PREFIX: Record<BootLine["kind"], string> = { p: "$ ", out: "[*] ", ok: "[+] " };

/**
 * Types the lines out one after another, then parks a blinking cursor on a
 * fresh prompt. Honours prefers-reduced-motion by rendering everything at once.
 * Re-key the component to restart it with new lines.
 */
export function BootSequence({ lines }: { lines: BootLine[] }) {
  const reduced = useMemo(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  const [pos, setPos] = useState(() => (reduced ? { line: lines.length, chars: 0, started: true } : { line: 0, chars: 0, started: false }));

  useEffect(() => {
    if (pos.line >= lines.length) return;
    const cur = lines[pos.line];
    const typing = pos.chars < cur.text.length;
    const delay = !pos.started ? 400 : typing ? cur.pace ?? 22 : 260;
    const t = setTimeout(() => {
      setPos(typing ? { line: pos.line, chars: pos.chars + 1, started: true } : { line: pos.line + 1, chars: 0, started: true });
    }, delay);
    return () => clearTimeout(t);
  }, [pos, lines]);

  const finished = pos.line >= lines.length;
  return (
    <div className="boot">
      {lines.map((l, i) => {
        if (i > pos.line) return <div key={i} className="line" aria-hidden />;
        const done = i < pos.line;
        const typed = done ? l.text : l.text.slice(0, pos.chars);
        return (
          <div key={i} className="line">
            <span className={l.kind}>{PREFIX[l.kind]}</span>
            {typed}
            {done && l.ok ? <span className="ok"> {l.ok}</span> : null}
            {i === pos.line && pos.started && <span className="cursor" />}
          </div>
        );
      })}
      {finished && <div className="line"><span className="p">$ </span><span className="cursor" /></div>}
    </div>
  );
}
