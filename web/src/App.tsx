import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchModels, streamChat } from "./api";
import { agentStatus, type AgentStatus } from "./agentApi";
import type { BotConfig, ChatMsg, SCXModel, ToolCall } from "./types";
import { Sidebar, type Mode } from "./Sidebar";
import { Chat } from "./Chat";
import { AgentPanel } from "./AgentPanel";
import { speak, stopSpeaking } from "./voice";
import { useEgress } from "./egress";

const STORAGE_KEY = "or_playground_config";
const RUNNER_KEY = "or_runner";
const MODE_KEY = "or_mode";
const LAYOUT_KEY = "or_layout";
const SIDEBAR_DEFAULT = 320;
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 560;

const DEFAULT_CONFIG: BotConfig = {
  name: "Assistant",
  model: "GLM-5.3",
  system: "You are a helpful, concise assistant.",
  temperature: 0.7,
  maxTokens: 4096,
  topP: 1,
  jsonMode: false,
  stream: true,
  tools: [],
  useKnowledge: false,
  speak: false,
};

export interface RunnerSettings {
  directory: string;
  model: string;
  recent: string[];
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...fallback, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return fallback;
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export default function App() {
  const [mode, setMode] = useState<Mode>(() => {
    try {
      return (localStorage.getItem(MODE_KEY) as Mode) || "runner";
    } catch {
      return "runner";
    }
  });

  // --- Runner (OpenCode agent) ---
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [runner, setRunner] = useState<RunnerSettings>(() => load(RUNNER_KEY, { directory: "", model: "", recent: [] }));

  useEffect(() => {
    agentStatus()
      .then((s) => {
        setStatus(s);
        setRunner((r) => ({
          ...r,
          directory: r.directory || s.directory,
          model: s.models.some((m) => m.id === r.model) ? r.model : s.defaultModel,
        }));
      })
      .catch((e) => setStatusError(String(e.message ?? e)));
  }, []);
  useEffect(() => save(RUNNER_KEY, runner), [runner]);
  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  const egress = useEgress();

  // --- Sessions: which one is showing, which one to open, list refresh ---
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [resume, setResume] = useState<{ id: string | null; n: number } | null>(null);
  const [sessionsVersion, setSessionsVersion] = useState(0);
  const openSession = (id: string | null) => {
    setMode("runner");
    setResume((r) => ({ id, n: (r?.n ?? 0) + 1 }));
  };
  const bumpSessions = useCallback(() => setSessionsVersion((v) => v + 1), []);

  // --- Sidebar layout: draggable width + collapse (Ctrl+B) ---
  const [layout, setLayout] = useState(() => load(LAYOUT_KEY, { width: SIDEBAR_DEFAULT, collapsed: false }));
  useEffect(() => save(LAYOUT_KEY, layout), [layout]);
  const toggleSidebar = () => setLayout((l) => ({ ...l, collapsed: !l.collapsed }));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") { e.preventDefault(); toggleSidebar(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) =>
      setLayout((l) => ({ ...l, width: Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX))) }));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }

  function openDirectory(directory: string) {
    setActiveSession(null);
    setResume(null);
    setRunner((r) => ({ ...r, directory, recent: [directory, ...r.recent.filter((d) => d !== directory)].slice(0, 8) }));
  }

  // --- Playground (direct SCX chat) ---
  const [config, setConfig] = useState<BotConfig>(() => load(STORAGE_KEY, DEFAULT_CONFIG));
  const [models, setModels] = useState<SCXModel[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetchModels()
      .then((m) => {
        setModels(m);
        // If the saved model is gone, fall back to the first text model.
        setConfig((c) => (m.some((x) => x.id === c.model) ? c : { ...c, model: m[0]?.id ?? c.model }));
      })
      .catch((e) => setModelError(String(e.message ?? e)));
  }, []);

  useEffect(() => save(STORAGE_KEY, config), [config]);

  const activeModel = useMemo(() => models.find((m) => m.id === config.model), [models, config.model]);

  /** Build the wire messages: system prompt + transcript. */
  function buildWireMessages(history: ChatMsg[]) {
    const wire: any[] = [];
    if (config.system.trim()) wire.push({ role: "system", content: config.system });
    for (const m of history) {
      if (m.role === "assistant" && m.tool_calls?.length) {
        wire.push({ role: "assistant", content: m.content ?? "", tool_calls: m.tool_calls });
      } else if (m.role === "tool") {
        wire.push({ role: "tool", content: m.content, tool_call_id: m.tool_call_id });
      } else {
        wire.push({ role: m.role, content: m.content });
      }
    }
    return wire;
  }

  async function runTurn(history: ChatMsg[]) {
    setBusy(true);
    setError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Push an empty assistant message we stream into.
    const assistantIndex = history.length;
    setMessages([...history, { role: "assistant", content: "" }]);

    const enabledTools = config.tools.length ? config.tools : undefined;
    let spoken = "";

    await streamChat(
      {
        model: config.model,
        messages: buildWireMessages(history),
        temperature: config.temperature,
        top_p: config.topP,
        max_tokens: config.maxTokens,
        tools: enabledTools,
        response_format: config.jsonMode ? { type: "json_object" } : undefined,
        rag: config.useKnowledge,
      },
      {
        signal: ctrl.signal,
        onDelta: (text) => {
          spoken += text;
          setMessages((prev) => {
            const next = [...prev];
            const a = next[assistantIndex];
            next[assistantIndex] = { ...a, content: (a.content ?? "") + text };
            return next;
          });
        },
        onToolCalls: (calls) =>
          setMessages((prev) => {
            const next = [...prev];
            next[assistantIndex] = { ...next[assistantIndex], tool_calls: calls };
            return next;
          }),
        onSources: (s) =>
          setMessages((prev) => {
            const next = [...prev];
            next[assistantIndex] = { ...next[assistantIndex], sources: s };
            return next;
          }),
        onUsage: (u) =>
          setMessages((prev) => {
            const next = [...prev];
            next[assistantIndex] = { ...next[assistantIndex], usage: u };
            return next;
          }),
        onError: (msg) => setError(msg),
        onDone: () => {
          if (config.speak && spoken.trim()) speak(spoken);
        },
      },
    ).catch((e) => {
      if (e?.name !== "AbortError") setError(String(e?.message ?? e));
    });

    setBusy(false);
    abortRef.current = null;
  }

  function send(text: string) {
    if (!text.trim() || busy) return;
    const history: ChatMsg[] = [...messages, { role: "user", content: text }];
    setMessages(history);
    void runTurn(history);
  }

  /** Submit a manual tool result, then continue the agentic loop. */
  function submitToolResult(call: ToolCall, result: string) {
    const history: ChatMsg[] = [...messages, { role: "tool", tool_call_id: call.id, content: result }];
    setMessages(history);
    void runTurn(history);
  }

  function stop() {
    abortRef.current?.abort();
    stopSpeaking();
    setBusy(false);
  }

  function reset() {
    stop();
    setMessages([]);
    setError(null);
  }

  return (
    <div
      className={"app" + (layout.collapsed ? " collapsed" : "")}
      style={{ "--sidebar-w": `${layout.width}px` } as React.CSSProperties}
    >
      {layout.collapsed && (
        <button className="sidebar-toggle floating" onClick={toggleSidebar} title="Show sidebar (Ctrl+B)" aria-label="Show sidebar">
          »
        </button>
      )}
      <Sidebar
        onCollapse={toggleSidebar}
        egress={egress}
        sessions={{ active: activeSession, version: sessionsVersion, open: openSession }}
        mode={mode}
        setMode={setMode}
        runner={runner}
        status={status}
        statusError={statusError}
        onOpenDirectory={openDirectory}
        config={config}
        setConfig={setConfig}
        models={models}
        modelError={modelError}
        activeModel={activeModel}
        onReset={reset}
      />
      <div
        className="splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        title="Drag to resize · double-click to reset"
        onPointerDown={startResize}
        onDoubleClick={() => setLayout((l) => ({ ...l, width: SIDEBAR_DEFAULT }))}
      />
      {mode === "runner" ? (
        runner.directory ? (
          <AgentPanel
            key={runner.directory}
            status={status}
            statusError={statusError}
            directory={runner.directory}
            model={runner.model || status?.defaultModel || ""}
            setModel={(model) => setRunner((r) => ({ ...r, model }))}
            egressPending={egress.pending}
            resume={resume}
            onActiveSession={setActiveSession}
            onSessionsChanged={bumpSessions}
          />
        ) : (
          <main className="main">
            <div className="transcript">
              <div className="empty-state">
                {statusError ? <div className="error-banner">{statusError}</div> : <p className="muted">Starting OpenCode…</p>}
              </div>
            </div>
          </main>
        )
      ) : (
        <Chat
          config={config}
          activeModel={activeModel}
          messages={messages}
          busy={busy}
          error={error}
          onSend={send}
          onStop={stop}
          onReset={reset}
          onToolResult={submitToolResult}
        />
      )}
    </div>
  );
}
