import { useEffect, useRef, useState } from "react";
import type { BotConfig, ChatMsg, SCXModel, ToolCall } from "./types";
import { dictate, speechSupported } from "./voice";
import { Markdown } from "./Markdown";
import { BootSequence, TerminalBar } from "./Terminal";

interface Props {
  config: BotConfig;
  activeModel?: SCXModel;
  messages: ChatMsg[];
  busy: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  onReset: () => void;
  onToolResult: (call: ToolCall, result: string) => void;
}

const SUGGESTIONS = [
  "Introduce yourself",
  "Write a haiku about the ocean",
  "Explain embeddings in one sentence",
  "Give me 3 startup name ideas",
];

export function Chat({ config, activeModel, messages, busy, error, onSend, onStop, onReset, onToolResult }: Props) {
  const [input, setInput] = useState("");
  const [listening, setListening] = useState(false);
  const dictationRef = useRef<{ stop: () => void } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Grow the box with its content (CSS min/max-height bound it).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 260) + "px";
  }, [input]);

  /** A click or tap on the card's padding (not on a control) focuses the input. */
  function focusInput(e: React.MouseEvent) {
    const t = e.target as HTMLElement;
    if (t.closest("button, select, input, textarea, a")) return;
    inputRef.current?.focus();
  }

  function toggleMic() {
    if (listening) {
      dictationRef.current?.stop();
      return;
    }
    const session = dictate({
      onStart: () => setListening(true),
      onEnd: () => {
        setListening(false);
        dictationRef.current = null;
      },
      onPartial: (text) => setInput(text),
    });
    dictationRef.current = session;
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function submit() {
    if (!input.trim() || busy) return;
    onSend(input);
    setInput("");
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const visible = messages.filter((m) => m.role !== "system");
  const modelName = activeModel?.name ?? config.model;

  return (
    <main className="main">
      <TerminalBar title={`bugxhunter@playground: ~/${modelName}`}>
        <span className={"status-pill" + (busy ? " live" : "")}>
          <span className="dot" />{busy ? (config.stream ? "streaming" : "thinking") : "ready"}
        </span>
        <button className="btn ghost sm" onClick={onReset} disabled={busy}>clear</button>
      </TerminalBar>

      <div className="transcript grid-bg" ref={scrollRef}>
        <div className="transcript-inner">
        {visible.length === 0 && (
          <div className="empty-state">
            <BootSequence
              key={modelName}
              lines={[
                { kind: "p", text: `./bxh --playground --model ${modelName}`, pace: 26 },
                { kind: "out", text: "Direct model access: no agent, no file system." },
                { kind: "out", text: "Tune the prompt and generation settings on the left.", pace: 18 },
                { kind: "ok", text: "Model ready ", ok: "OK" },
              ]}
            />
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button className="chip" key={s} onClick={() => onSend(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {visible.map((m, i) => (
          <MessageRow key={i} msg={m} streaming={busy && i === visible.length - 1} onToolResult={onToolResult} />
        ))}

        {error && <div className="error-banner">{error}</div>}
        </div>
      </div>

      <div className="composer">
        <div className="composer-box" onClick={focusInput}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            rows={3}
            placeholder={listening ? "Listening…" : `Message ${modelName}…`}
          />
          <div className="composer-bar">
            <div className="spacer" />
            {speechSupported() && (
              <button
                className={"send-btn mic" + (listening ? " stop" : "")}
                onClick={toggleMic}
                title={listening ? "Stop dictation" : "Dictate"}
              >
                {listening ? "●" : "🎤"}
              </button>
            )}
            {busy ? (
              <button className="send-btn stop" onClick={onStop} title="Stop">■</button>
            ) : (
              <button className="send-btn" onClick={submit} disabled={!input.trim()} title="Send">↑</button>
            )}
          </div>
        </div>
        <div className="composer-hint">Enter to send · Shift+Enter for a new line</div>
      </div>
    </main>
  );
}

function MessageRow({ msg, streaming, onToolResult }: {
  msg: ChatMsg; streaming: boolean; onToolResult: (c: ToolCall, r: string) => void;
}) {
  const isUser = msg.role === "user";
  const isTool = msg.role === "tool";

  if (isTool) {
    return (
      <div className="msg assistant">
        <div className="avatar fn" aria-hidden>fn</div>
        <div className="msg-body">
          <div className="tool-call">
            <span className="tc-name">tool result</span>
            <pre>{msg.content}</pre>
          </div>
        </div>
      </div>
    );
  }

  if (isUser) {
    return (
      <div className="msg user">
        <div className="bubble user-bubble">{msg.content}</div>
      </div>
    );
  }

  return (
    <div className="msg assistant">
      <div className="avatar" aria-hidden>▶</div>
      <div className="msg-body">
        <div>
          {msg.content ? <Markdown text={msg.content} /> : null}
          {streaming && !msg.tool_calls && <span className="cursor" />}
          {msg.tool_calls?.map((tc) => (
            <ToolCallCard key={tc.id} call={tc} onResult={onToolResult} />
          ))}
        </div>
        {msg.sources && msg.sources.length > 0 && (
          <div className="sources">
            <span className="sources-label">grounded in</span>
            {msg.sources.map((s, i) => (
              <span className="badge on" key={i} title={`similarity ${s.score}`}>{s.doc}</span>
            ))}
          </div>
        )}
        {msg.usage && (
          <div className="msg-meta">
            {msg.usage.prompt ?? 0} in · {msg.usage.completion ?? 0} out
            {msg.usage.reasoning ? ` · ${msg.usage.reasoning} reasoning` : ""} tokens
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCallCard({ call, onResult }: { call: ToolCall; onResult: (c: ToolCall, r: string) => void }) {
  const [result, setResult] = useState("");
  const [sent, setSent] = useState(false);
  let pretty = call.function.arguments;
  try {
    pretty = JSON.stringify(JSON.parse(call.function.arguments), null, 2);
  } catch {
    /* leave raw */
  }
  return (
    <div className="tool-call">
      <span className="tc-name">{call.function.name}()</span>
      <pre>{pretty}</pre>
      {!sent ? (
        <div className="tc-result">
          <textarea
            placeholder='Return a tool result (JSON or text), then continue…'
            value={result}
            onChange={(e) => setResult(e.target.value)}
            style={{ minHeight: 50, fontSize: 12 }}
          />
          <button
            className="btn mini"
            style={{ marginTop: 6 }}
            disabled={!result.trim()}
            onClick={() => { onResult(call, result); setSent(true); }}
          >
            Submit result &amp; continue
          </button>
        </div>
      ) : (
        <div className="tc-result mini" style={{ color: "var(--muted)" }}>↳ result submitted</div>
      )}
    </div>
  );
}
