import { useRef, useState } from "react";
import { runChat } from "./api";
import type { BotConfig, ChatMsg, SCXModel } from "./types";
import { Markdown } from "./Markdown";
import { TerminalBar } from "./Terminal";
import { PaperclipIcon } from "./icons";
import { formatTiming } from "./format";
import { isChatModel } from "./modelFilter";
import { userContent } from "./wire";
import { ATTACH_ACCEPT, AttachChips, useImageAttach } from "./imageAttach";

// One prompt, run against two or three models side by side. Single-turn on purpose: the point
// is to compare answers (and speed) to the same question, so each run starts clean, using the
// sidebar's system prompt and generation settings. Tools and knowledge grounding stay in chat.

const MAX_COLS = 3;
const PROVIDER_LABEL: Record<string, string> = { scx: "SCX.ai", nvidia: "NVIDIA NIM", openrouter: "OpenRouter" };

interface Column {
  model: string;
  text: string;
  busy: boolean;
  error: string | null;
  skipped?: string;
  timing?: ChatMsg["timing"];
  usage?: ChatMsg["usage"];
}

const blank = (model: string): Column => ({ model, text: "", busy: false, error: null });

/** A model not already taken, preferring a different provider from the first column. */
function pickOther(chat: SCXModel[], taken: string[]): string | undefined {
  const first = chat.find((m) => m.id === taken[0]);
  const free = chat.filter((m) => !taken.includes(m.id));
  return (free.find((m) => (m.provider ?? "scx") !== (first?.provider ?? "scx")) ?? free[0])?.id;
}

interface Props {
  config: BotConfig;
  models: SCXModel[];
  onExit: () => void;
}

export function Compare({ config, models, onExit }: Props) {
  const chat = models.filter(isChatModel);
  const [cols, setCols] = useState<Column[]>(() =>
    [config.model, pickOther(chat, [config.model])].filter((m): m is string => Boolean(m)).map(blank),
  );
  const [prompt, setPrompt] = useState("");
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const att = useImageAttach();
  const fileRef = useRef<HTMLInputElement>(null);
  const aborts = useRef<AbortController[]>([]);
  const running = cols.some((c) => c.busy);

  const patch = (i: number, p: Partial<Column>) =>
    setCols((cur) => cur.map((c, j) => (j === i ? { ...c, ...p } : c)));

  function stopAll() {
    aborts.current.forEach((a) => a.abort());
    aborts.current = [];
  }

  function run() {
    if ((!prompt.trim() && !att.images.length && !att.docs.length) || running || att.reading) return;
    stopAll();
    const images = att.images;
    const messages = [
      ...(config.system.trim() ? [{ role: "system", content: config.system }] : []),
      { role: "user", content: userContent(prompt, images, att.docs) },
    ];
    const extras = [
      images.length ? `${images.length} image${images.length > 1 ? "s" : ""}` : "",
      ...att.docs.map((d) => d.name),
    ].filter(Boolean);
    setLastPrompt((prompt.trim() || (att.docs.length ? "Review this diagram for security issues." : "Describe this image.")) + (extras.length ? `  [+${extras.join(", ")}]` : ""));
    aborts.current = cols.map(() => new AbortController());

    cols.forEach((c, i) => {
      const model = models.find((m) => m.id === c.model);
      if (images.length && !model?.input_modalities?.includes("image")) {
        setCols((cur) => cur.map((x, j) => (j === i ? { ...blank(x.model), skipped: "This model can't see images, so it was skipped." } : x)));
        return;
      }
      setCols((cur) => cur.map((x, j) => (j === i ? { ...blank(x.model), busy: true } : x)));
      const started = performance.now();
      let first: number | undefined;
      runChat(
        {
          model: c.model,
          messages,
          temperature: config.temperature,
          top_p: config.topP,
          max_tokens: config.maxTokens,
          response_format: config.jsonMode ? { type: "json_object" } : undefined,
          stream: config.stream,
        },
        {
          signal: aborts.current[i]?.signal,
          onDelta: (t) => {
            first ??= performance.now() - started;
            setCols((cur) => cur.map((x, j) => (j === i ? { ...x, text: x.text + t } : x)));
          },
          onUsage: (u) => patch(i, { usage: u }),
          onError: (msg) => patch(i, { error: msg }),
          onDone: () => patch(i, { timing: { ttft: first, total: performance.now() - started } }),
        },
      )
        .catch((e) => {
          if (e?.name !== "AbortError") patch(i, { error: String(e?.message ?? e) });
        })
        .finally(() => patch(i, { busy: false }));
    });
    setPrompt("");
    att.clear();
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      run();
    }
  }

  const groups = (["scx", "nvidia", "openrouter"] as const)
    .map((p) => [p, chat.filter((m) => (m.provider ?? "scx") === p)] as const)
    .filter(([, list]) => list.length > 0);
  const anyVision = cols.some((c) => models.find((m) => m.id === c.model)?.input_modalities?.includes("image"));

  return (
    <main className="main">
      <TerminalBar title={`bugxhunter@playground: ~/compare (${cols.length} models)`}>
        <span className={"status-pill" + (running ? " live" : "")}>
          <span className="dot" />{running ? "running" : "ready"}
        </span>
        {cols.length < MAX_COLS && (
          <button
            className="btn ghost sm"
            disabled={running}
            onClick={() => setCols((cur) => [...cur, blank(pickOther(chat, cur.map((c) => c.model)) ?? config.model)])}
          >
            + model
          </button>
        )}
        <button className="btn ghost sm" onClick={() => { stopAll(); onExit(); }}>back to chat</button>
      </TerminalBar>

      <div className="transcript grid-bg">
        {lastPrompt && <div className="compare-prompt mono">$ {lastPrompt}</div>}
        <div className="compare-grid" style={{ "--cols": cols.length } as React.CSSProperties}>
          {cols.map((c, i) => (
            <section className="compare-col" key={i}>
              <div className="compare-head">
                <select value={c.model} disabled={running} onChange={(e) => patch(i, { ...blank(e.target.value) })} aria-label={`Model ${i + 1}`}>
                  {!chat.some((m) => m.id === c.model) && <option value={c.model}>{c.model}</option>}
                  {groups.map(([p, list]) => (
                    <optgroup key={p} label={PROVIDER_LABEL[p]}>
                      {list.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}{m.input_modalities?.includes("image") ? " · vision" : ""}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {cols.length > 1 && (
                  <button className="attach-x" disabled={running} onClick={() => setCols((cur) => cur.filter((_, j) => j !== i))} aria-label="Remove this model">✕</button>
                )}
              </div>
              <div className="compare-body">
                {c.skipped && <div className="hint" style={{ color: "var(--amber)" }}>{c.skipped}</div>}
                {c.error && <div className="error-banner">{c.error}</div>}
                {c.text && <Markdown text={c.text} />}
                {c.busy && <span className="cursor" />}
                {!c.text && !c.busy && !c.skipped && !c.error && (
                  <p className="muted mono" style={{ margin: 0 }}>{lastPrompt ? "No answer." : "Waiting for a prompt…"}</p>
                )}
              </div>
              {(c.timing || c.usage) && (
                <div className="msg-meta">
                  {c.timing && formatTiming(c.timing, c.usage?.completion, c.usage?.reasoning)}
                  {c.usage && `${c.timing ? " · " : ""}${c.usage.prompt ?? 0} in · ${c.usage.completion ?? 0} out tokens`}
                </div>
              )}
            </section>
          ))}
        </div>
      </div>

      <div className="composer">
        <div className="composer-box" onDragOver={(e) => e.preventDefault()} onDrop={att.onDrop}>
          <AttachChips images={att.images} docs={att.docs} reading={att.reading} onRemove={att.remove} onRemoveDoc={att.removeDoc} />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKey}
            onPaste={att.onPaste}
            rows={3}
            placeholder={`Ask all ${cols.length} models the same thing…${anyVision ? " (images go to the vision models)" : ""}`}
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
            <button className="icon-btn attach-btn" onClick={() => fileRef.current?.click()} disabled={running} title="Attach images (or paste / drop them)" aria-label="Attach images">
              <PaperclipIcon />
            </button>
            {att.attachError && <span className="hint" style={{ color: "var(--amber)", margin: "0 8px" }}>{att.attachError}</span>}
            <div className="spacer" />
            {running ? (
              <button className="send-btn stop" onClick={stopAll} title="Stop all">■</button>
            ) : (
              <button className="send-btn" onClick={run} disabled={(!prompt.trim() && !att.images.length && !att.docs.length) || att.reading} title="Run on all models">↑</button>
            )}
          </div>
        </div>
        <div className="composer-hint">Enter to run on every model · uses the sidebar's system prompt and settings · single turn</div>
      </div>
    </main>
  );
}
