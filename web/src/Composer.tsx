import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentModel, FileUpload, SlashCommand } from "./agentApi";

export type AgentName = "build" | "plan";

/** Commands handled by the UI itself; OpenCode's own (e.g. /init, /review) are merged in. */
export const LOCAL_COMMANDS: SlashCommand[] = [
  { name: "new", description: "Start a new session", hint: "" },
  { name: "compact", description: "Summarise the conversation to free up context", hint: "" },
  { name: "model", description: "Switch model, e.g. /model kimi", hint: "<name>" },
  { name: "plan", description: "Switch to the read-only plan agent", hint: "" },
  { name: "build", description: "Switch to the build agent", hint: "" },
  { name: "help", description: "List available commands", hint: "" },
];

const MAX_FILE = 25 * 1024 * 1024;

// Terminal-style command history (shared across sessions, survives reloads).
const HISTORY_KEY = "or_cmd_history";
const HISTORY_MAX = 200;
function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return [];
}

interface Props {
  agent: AgentName;
  setAgent: (a: AgentName) => void;
  model: string;
  setModel: (m: string) => void;
  models: AgentModel[];
  commands: SlashCommand[];
  busy: boolean;
  onSend: (text: string, files: FileUpload[]) => void;
  onStop: () => void;
  /** Set to put text into the box (e.g. from a suggestion); cleared via onDraftUsed. */
  draft: string | null;
  onDraftUsed: () => void;
}

export function Composer({ agent, setAgent, model, setModel, models, commands, busy, onSend, onStop, draft, onDraftUsed }: Props) {
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<FileUpload[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // --- command history (Up/Down like a terminal) ---
  const [history, setHistory] = useState<string[]>(loadHistory);
  const histIndex = useRef(-1); // -1 = editing the live draft, not browsing history
  const histStash = useRef(""); // the live draft, saved while browsing

  function pushHistory(text: string) {
    if (!text.trim()) return;
    setHistory((h) => {
      const next = (h[h.length - 1] === text ? h : [...h, text]).slice(-HISTORY_MAX);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  function moveCaretEnd() {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) el.selectionStart = el.selectionEnd = el.value.length;
    });
  }
  // Up pulls history only from the first line; Down only from the last line —
  // so arrow keys still move between lines in a multi-line prompt.
  const caretOnFirstLine = () => {
    const el = inputRef.current;
    return !el || !el.value.slice(0, el.selectionStart ?? 0).includes("\n");
  };
  const caretOnLastLine = () => {
    const el = inputRef.current;
    return !el || !el.value.slice(el.selectionEnd ?? 0).includes("\n");
  };

  function recall(dir: -1 | 1): boolean {
    if (!history.length) return false;
    if (histIndex.current === -1) {
      if (dir === 1) return false; // Down with no active browse: leave as-is
      histStash.current = input;
      histIndex.current = history.length - 1;
    } else {
      const ni = histIndex.current + dir;
      if (ni < 0) return true; // already at the oldest; swallow the key
      if (ni >= history.length) {
        histIndex.current = -1; // past the newest: restore the live draft
        setInput(histStash.current);
        moveCaretEnd();
        return true;
      }
      histIndex.current = ni;
    }
    setInput(history[histIndex.current]);
    moveCaretEnd();
    return true;
  }

  useEffect(() => {
    if (draft === null) return;
    setInput(draft);
    onDraftUsed();
    inputRef.current?.focus();
  }, [draft, onDraftUsed]);

  // Grow the box with its content.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [input]);

  // --- slash command menu: open while typing the command name ---
  const allCommands = useMemo(() => {
    const seen = new Set(LOCAL_COMMANDS.map((c) => c.name));
    return [...LOCAL_COMMANDS, ...commands.filter((c) => !seen.has(c.name))];
  }, [commands]);
  const slash = /^\/(\S*)$/.exec(input);
  const matches = slash ? allCommands.filter((c) => c.name.startsWith(slash[1].toLowerCase())) : [];
  const menuOpen = matches.length > 0;
  useEffect(() => setSel(0), [slash?.[1]]);

  function pick(c: SlashCommand) {
    if (!c.hint) {
      // No arguments: run it straight away.
      submit(`/${c.name}`);
    } else {
      setInput(`/${c.name} `);
      inputRef.current?.focus();
    }
  }

  // --- attachments ---
  async function addFiles(list: FileList | File[]) {
    setFileError(null);
    const next: FileUpload[] = [];
    for (const f of Array.from(list)) {
      if (f.size > MAX_FILE) {
        setFileError(`${f.name} is over 25 MB.`);
        continue;
      }
      const dataUrl = await readAsDataUrl(f);
      next.push({
        name: f.name || `pasted-${Date.now()}.${(f.type.split("/")[1] || "bin").replace(/\W/g, "")}`,
        mime: f.type || "application/octet-stream",
        size: f.size,
        data: dataUrl.slice(dataUrl.indexOf(",") + 1),
        preview: f.type.startsWith("image/") ? dataUrl : undefined,
      });
    }
    setFiles((cur) => [...cur, ...next]);
  }

  function onPaste(e: React.ClipboardEvent) {
    const pasted = Array.from(e.clipboardData.files);
    if (pasted.length) {
      e.preventDefault();
      addFiles(pasted);
    }
  }

  function submit(text = input) {
    // Allowed while busy: the parent queues it (type-ahead, like a terminal).
    if (!text.trim() && !files.length) return;
    pushHistory(text);
    histIndex.current = -1;
    onSend(text, files);
    setInput("");
    setFiles([]);
    setFileError(null);
  }

  function onKey(e: React.KeyboardEvent) {
    if (menuOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % matches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + matches.length) % matches.length); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); pick(matches[sel]); return; }
      if (e.key === "Escape") { e.preventDefault(); setInput(""); return; }
    }
    // Terminal-style history — only when the slash menu isn't capturing arrows.
    if (e.key === "ArrowUp" && caretOnFirstLine() && recall(-1)) { e.preventDefault(); return; }
    if (e.key === "ArrowDown" && histIndex.current !== -1 && caretOnLastLine() && recall(1)) { e.preventDefault(); return; }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const activeModel = models.find((m) => m.id === model);
  const byProvider = useMemo(() => {
    const groups = new Map<string, AgentModel[]>();
    for (const m of models) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
    return [...groups.entries()];
  }, [models]);
  const hasImages = files.some((f) => f.mime.startsWith("image/"));

  return (
    <div className="composer-wrap">
      {menuOpen && (
        <div className="slash-menu" role="listbox">
          {matches.map((c, i) => (
            <button
              key={c.name}
              role="option"
              aria-selected={i === sel}
              className={"slash-item" + (i === sel ? " on" : "")}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(c); }}
            >
              <span className="slash-name mono">/{c.name}{c.hint ? <span className="slash-hint"> {c.hint}</span> : null}</span>
              <span className="slash-desc">{c.description}</span>
            </button>
          ))}
        </div>
      )}

      <div
        className={"composer-box" + (dragging ? " dragging" : "")}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}
      >
        {files.length > 0 && (
          <div className="attach-row">
            {files.map((f, i) => (
              <span className="attach-chip" key={i} title={`${f.name} · ${formatBytes(f.size)}`}>
                {f.preview ? <img src={f.preview} alt="" /> : <span className="attach-icon">📄</span>}
                <span className="attach-name">{f.name}</span>
                <button className="attach-x" onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>✕</button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => { setInput(e.target.value); histIndex.current = -1; }}
          onKeyDown={onKey}
          onPaste={onPaste}
          rows={1}
          placeholder={agent === "build" ? "Ask Open Runner to change something…  (/ for commands)" : "Ask Open Runner to plan or explain…  (/ for commands)"}
        />
        <div className="composer-bar">
          <button className="icon-btn" onClick={() => fileRef.current?.click()} title="Attach files (or paste / drop them)" aria-label="Attach files">
            📎
          </button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
          <div className="agent-switch" role="tablist">
            {(["build", "plan"] as const).map((a) => (
              <button key={a} className={"seg" + (agent === a ? " on" : "")} onClick={() => setAgent(a)} disabled={busy}>
                {a}
              </button>
            ))}
          </div>
          <select className="model-select" value={model} onChange={(e) => setModel(e.target.value)} disabled={busy} title="Model">
            {!activeModel && <option value={model}>{model}</option>}
            {byProvider.map(([provider, list]) => (
              <optgroup key={provider} label={provider}>
                {list.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}{m.images ? " · sees images" : ""}{m.output ? ` · ${formatTokens(m.output)} out` : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <div className="spacer" />
          {busy ? (
            <button className="send-btn stop" onClick={onStop} title="Stop">■</button>
          ) : (
            <button className="send-btn" onClick={() => submit()} disabled={!input.trim() && !files.length} title="Send (Enter)">↑</button>
          )}
        </div>
      </div>
      <div className="composer-hint">
        {fileError ? <span className="danger">{fileError}</span>
          : hasImages && activeModel && !activeModel.images
            ? <span className="warn">{activeModel.name} can't see images — it gets the saved file only. Pick a model marked “sees images” to let it look.</span>
            : "Enter to send · Shift+Enter new line · / commands · paste or drop files"}
      </div>
    </div>
  );
}

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

export function formatBytes(n: number) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

export function formatTokens(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0) + "M";
  if (n >= 1000) return Math.round(n / 1000) + "k";
  return String(n);
}
