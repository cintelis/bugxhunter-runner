import { useEffect, useRef, useState } from "react";
import type { BotConfig, ChatDoc, ChatImage, ChatMsg, SCXModel, ToolCall } from "./types";
import { dictate, speechSupported } from "./voice";
import { BootSequence, TerminalBar } from "./Terminal";
import { PaperclipIcon } from "./icons";
import { DEFAULT_STARTERS, presetFor } from "./presets";
import { formatTiming } from "./format";
import { ATTACH_ACCEPT, AttachChips, useImageAttach } from "./imageAttach";
import { RichReply } from "./DrawioBlock";

interface Props {
  config: BotConfig;
  activeModel?: SCXModel;
  messages: ChatMsg[];
  busy: boolean;
  error: string | null;
  onSend: (text: string, images?: ChatImage[], docs?: ChatDoc[]) => void;
  onStop: () => void;
  onReset: () => void;
  onToolResult: (call: ToolCall, result: string) => void;
  /** Switch to side-by-side model comparison. */
  onCompare: () => void;
  /** Switch to the threat-model canvas. */
  onCanvas: () => void;
}

export function Chat({ config, activeModel, messages, busy, error, onSend, onStop, onReset, onToolResult, onCompare, onCanvas }: Props) {
  const [input, setInput] = useState("");
  const att = useImageAttach();
  const images = att.images;
  const [listening, setListening] = useState(false);
  const dictationRef = useRef<{ stop: () => void } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const seesImages = activeModel?.input_modalities?.includes("image") ?? false;
  // Images on a text-only model would just fail upstream; say so instead of sending.
  const blocked = images.length > 0 && !seesImages;

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
    if ((!input.trim() && !images.length && !att.docs.length) || busy || blocked || att.reading) return;
    onSend(input, images.length ? images : undefined, att.docs.length ? att.docs : undefined);
    setInput("");
    att.clear();
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const visible = messages.filter((m) => m.role !== "system");
  const modelName = activeModel?.name ?? config.model;
  const preset = presetFor(config.system);
  const starters = preset?.starters ?? DEFAULT_STARTERS;

  /** Starters fill the box (cursor at the end) so code, logs or an image can be added first. */
  function applyStarter(text: string) {
    setInput(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  }

  return (
    <main className="main">
      <TerminalBar title={`bugxhunter@playground: ~/${modelName}`}>
        <span className={"status-pill" + (busy ? " live" : "")}>
          <span className="dot" />{busy ? (config.stream ? "streaming" : "thinking") : "ready"}
        </span>
        <button className="btn ghost sm" onClick={onCanvas} disabled={busy} title="Threat-model canvas: map a system from a diagram and track its findings">canvas</button>
        <button className="btn ghost sm" onClick={onCompare} disabled={busy} title="Ask 2–3 models the same question side by side">compare</button>
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
                {
                  kind: "out",
                  text: preset
                    ? `Preset: ${preset.label}.${seesImages ? " Attach, paste or drop an image to review." : ""}`
                    : "Pick a security preset or tune the prompt on the left.",
                  pace: 18,
                },
                { kind: "ok", text: "Model ready ", ok: "OK" },
              ]}
            />
            <div className="suggestions">
              {starters.map((s) => (
                <button className="chip" key={s} onClick={() => applyStarter(s)} title="Puts this in the message box">
                  {s.trim()}
                </button>
              ))}
            </div>
          </div>
        )}

        {visible.map((m, i) => (
          <MessageRow key={i} msg={m} streaming={busy && i === visible.length - 1} onToolResult={onToolResult} onFix={busy ? undefined : (t) => onSend(t)} />
        ))}

        {error && <div className="error-banner">{error}</div>}
        </div>
      </div>

      <div className="composer">
        <div
          className="composer-box"
          onClick={focusInput}
          onDragOver={(e) => e.preventDefault()}
          onDrop={att.onDrop}
        >
          <AttachChips images={images} docs={att.docs} reading={att.reading} onRemove={att.remove} onRemoveDoc={att.removeDoc} />
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            onPaste={att.onPaste}
            rows={3}
            placeholder={
              listening
                ? "Listening…"
                : seesImages
                  ? `Message ${modelName}… (attach, paste or drop an image or a .drawio file to review)`
                  : `Message ${modelName}… (attach or drop a .drawio file to review a diagram)`
            }
          />
          <div className="composer-bar">
            <input
              ref={fileRef}
              type="file"
              accept={ATTACH_ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void att.addImages(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              className="icon-btn attach-btn"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              title={seesImages ? "Attach images or draw.io diagrams (or paste / drop them)" : "Attach draw.io diagrams (images need a vision model)"}
              aria-label="Attach images or diagrams"
            >
              <PaperclipIcon />
            </button>
            {!blocked && !att.attachError && att.docs.length > 0 && config.maxTokens < 12000 && (
              <span className="hint" style={{ margin: "0 8px" }} title="Reasoning models think before they answer; a short limit can end the reply before any text">
                Diagram reviews can need 10–16k output tokens; Max tokens is {config.maxTokens.toLocaleString()}.
              </span>
            )}
            {(blocked || att.attachError) && (
              <span className="hint" style={{ color: "var(--amber)", margin: "0 8px" }}>
                {blocked ? `${modelName} can't see images — pick a vision model (e.g. Nemotron 3.5 Super VL)` : att.attachError}
              </span>
            )}
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
              <button className="send-btn" onClick={submit} disabled={(!input.trim() && !images.length) || blocked} title="Send">↑</button>
            )}
          </div>
        </div>
        <div className="composer-hint">Enter to send · Shift+Enter for a new line</div>
      </div>
    </main>
  );
}

function MessageRow({ msg, streaming, onToolResult, onFix }: {
  msg: ChatMsg; streaming: boolean; onToolResult: (c: ToolCall, r: string) => void;
  /** Send a "fix your diagram" message (absent while a reply is streaming). */
  onFix?: (text: string) => void;
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
        <div className="bubble user-bubble">
          {msg.content}
          {msg.images?.length ? (
            <div className="bubble-images">
              {msg.images.map((img, i) => (
                <img key={i} src={img.url} alt={img.name} title={img.name} />
              ))}
            </div>
          ) : null}
          {msg.docs?.length ? (
            <div className="attach-row bubble-docs">
              {msg.docs.map((d, i) => (
                <span className="attach-chip doc" key={i} title={`Sent as an exact outline (${d.text.length.toLocaleString()} characters)`}>
                  <span className="attach-doc-icon" aria-hidden>◇</span>
                  <span className="attach-name">{d.name}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="msg assistant">
      <div className="avatar" aria-hidden>▶</div>
      <div className="msg-body">
        <div>
          {msg.content ? <RichReply text={msg.content} streaming={streaming} onFix={onFix} /> : null}
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
        {(msg.usage || msg.timing) && (
          <div className="msg-meta">
            {msg.timing && formatTiming(msg.timing, msg.usage?.completion, msg.usage?.reasoning)}
            {msg.timing && msg.usage && " · "}
            {msg.usage && (
              <>
                {msg.usage.prompt ?? 0} in · {msg.usage.completion ?? 0} out
                {msg.usage.reasoning ? ` · ${msg.usage.reasoning} reasoning` : ""} tokens
              </>
            )}
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
