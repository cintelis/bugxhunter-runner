import { useEffect, useState } from "react";
import { Logo } from "./brand";
import { kbAdd, kbDelete, kbList } from "./api";
import { agentCheckDirectory, agentSessions, agentDeleteSession, type AgentStatus, type SessionSummary } from "./agentApi";
import { speechSupported } from "./voice";
import type { BotConfig, KBDoc, SCXModel, ToolDef } from "./types";
import type { RunnerSettings } from "./App";
import { logout } from "./Login";
import { newToolId } from "./tools";

export type Mode = "runner" | "playground";

export interface SessionNav {
  active: string | null;
  /** Bumped when the list may have changed. */
  version: number;
  open: (id: string | null) => void;
}

interface Props {
  onCollapse: () => void;
  sessions: SessionNav;
  mode: Mode;
  setMode: (m: Mode) => void;
  runner: RunnerSettings;
  status: AgentStatus | null;
  statusError: string | null;
  onOpenDirectory: (dir: string) => void;
  config: BotConfig;
  setConfig: (updater: (c: BotConfig) => BotConfig) => void;
  models: SCXModel[];
  modelError: string | null;
  activeModel?: SCXModel;
  onReset: () => void;
}

const EXAMPLE_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  },
};

export function Sidebar({
  onCollapse, sessions, mode, setMode, runner, status, statusError, onOpenDirectory,
  config, setConfig, models, modelError, activeModel, onReset,
}: Props) {
  const set = <K extends keyof BotConfig>(k: K, v: BotConfig[K]) => setConfig((c) => ({ ...c, [k]: v }));

  const [authOn, setAuthOn] = useState(false);
  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then((me) => setAuthOn(Boolean(me.required))).catch(() => {});
  }, []);

  // --- Knowledge base (RAG) state ---
  const [docs, setDocs] = useState<KBDoc[]>([]);
  const [docName, setDocName] = useState("");
  const [docText, setDocText] = useState("");
  const [adding, setAdding] = useState(false);
  const [kbError, setKbError] = useState<string | null>(null);
  const [toolMsg, setToolMsg] = useState<string | null>(null);

  useEffect(() => {
    kbList().then(setDocs).catch(() => {});
  }, []);

  async function addDoc() {
    if (!docText.trim()) return;
    setAdding(true);
    setKbError(null);
    try {
      const updated = await kbAdd(docName.trim() || `Document ${docs.length + 1}`, docText);
      setDocs(updated);
      setDocName("");
      setDocText("");
      if (!config.useKnowledge) set("useKnowledge", true);
    } catch (e) {
      setKbError(String((e as Error).message ?? e));
    } finally {
      setAdding(false);
    }
  }
  async function removeDoc(id: string) {
    setDocs(await kbDelete(id));
  }

  const features = activeModel?.supported_features ?? [];
  const supportsTools = features.includes("tools");
  const supportsJson = features.includes("json_mode");
  const supportsReasoning = features.includes("reasoning");

  // group models by primary modality for a tidy picker
  const textModels = models.filter((m) => m.output_modalities.includes("text"));

  function updateTool(i: number, patch: Partial<ToolDef["function"]>) {
    setConfig((c) => {
      const tools = c.tools.slice();
      tools[i] = { ...tools[i], function: { ...tools[i].function, ...patch } };
      return { ...c, tools };
    });
  }
  function updateToolParams(i: number, text: string) {
    try {
      const parsed = JSON.parse(text);
      updateTool(i, { parameters: parsed });
    } catch {
      /* keep typing; invalid JSON is ignored until valid */
    }
  }

  /** Coerce a raw entry (full ToolDef or a bare {name,parameters}) into a ToolDef. */
  function normalizeTool(raw: any): ToolDef | null {
    if (!raw) return null;
    const fn = raw.function ?? raw;
    if (!fn?.name) return null;
    return { type: "function", id: newToolId(), function: { name: fn.name, description: fn.description, parameters: fn.parameters ?? fn.schema } };
  }

  /** Import the agent-authored tool schemas from web/public/example-tools.json. */
  async function loadExampleTools() {
    setToolMsg(null);
    try {
      const r = await fetch("/example-tools.json", { cache: "no-store" });
      if (!r.ok) throw new Error(`No example-tools.json yet (${r.status}) — add web/public/example-tools.json first.`);
      const data = await r.json();
      const arr = (Array.isArray(data) ? data : data.tools ?? []).map(normalizeTool).filter(Boolean) as ToolDef[];
      if (!arr.length) throw new Error("File had no valid tools.");
      let added = 0;
      setConfig((c) => {
        const have = new Set(c.tools.map((t) => t.function.name));
        const incoming = arr.filter((t) => !have.has(t.function.name));
        added = incoming.length;
        return { ...c, tools: [...c.tools, ...incoming] };
      });
      setToolMsg(added ? `Loaded ${added} tool${added > 1 ? "s" : ""}.` : "Already loaded.");
    } catch (e) {
      setToolMsg(String((e as Error).message ?? e));
    }
  }

  function exportConfig() {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${config.name.replace(/\s+/g, "-").toLowerCase() || "bot"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-top">
          <Logo />
          <button className="sidebar-toggle" onClick={onCollapse} title="Hide sidebar (Ctrl+B)" aria-label="Hide sidebar">«</button>
        </div>
        <div className="mode-switch">
          {(["runner", "playground"] as const).map((m) => (
            <button key={m} className={"seg" + (mode === m ? " on" : "")} onClick={() => setMode(m)}>
              {m === "runner" ? "Runner" : "Playground"}
            </button>
          ))}
        </div>
      </div>
      {mode === "runner" ? (
        <RunnerSidebar runner={runner} status={status} statusError={statusError} onOpen={onOpenDirectory} sessions={sessions} />
      ) : (
      <div className="sidebar-body">
        <p className="hint" style={{ marginTop: 0 }}>
          Chat with any SCX model directly — no agent, no file access. Useful for comparing models and prompts.
        </p>
        <div className="section-title">Identity</div>

        <div className="field">
          <label>Bot name</label>
          <input type="text" value={config.name} onChange={(e) => set("name", e.target.value)} />
        </div>

        <div className="field">
          <label>Model</label>
          <select value={config.model} onChange={(e) => set("model", e.target.value)}>
            {textModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.context_length ? ` · ${Math.round(m.context_length / 1000)}k ctx` : ""}
              </option>
            ))}
          </select>
          {modelError && <div className="hint" style={{ color: "var(--danger)" }}>{modelError}</div>}
          {activeModel?.description && <div className="hint">{activeModel.description}</div>}
          <div className="cap-badges">
            <span className={"badge" + (supportsTools ? " on" : "")}>tools</span>
            <span className={"badge" + (supportsJson ? " on" : "")}>json</span>
            <span className={"badge" + (supportsReasoning ? " on" : "")}>reasoning</span>
            {activeModel?.datacenters?.map((d) => (
              <span key={d.country_code} className="badge">{d.country_code}</span>
            ))}
          </div>
        </div>

        <div className="field">
          <label>System prompt</label>
          <textarea
            value={config.system}
            onChange={(e) => set("system", e.target.value)}
            placeholder="Describe the bot's personality, role, and rules…"
            style={{ minHeight: 110 }}
          />
        </div>

        <div className="section-title">Generation</div>

        <div className="field">
          <label>Temperature</label>
          <div className="range-row">
            <input type="range" min={0} max={2} step={0.05} value={config.temperature}
              onChange={(e) => set("temperature", Number(e.target.value))} />
            <span className="range-val">{config.temperature.toFixed(2)}</span>
          </div>
        </div>

        <div className="field">
          <label>Top P</label>
          <div className="range-row">
            <input type="range" min={0} max={1} step={0.05} value={config.topP}
              onChange={(e) => set("topP", Number(e.target.value))} />
            <span className="range-val">{config.topP.toFixed(2)}</span>
          </div>
        </div>

        <div className="field">
          <label>Max output tokens</label>
          <div className="range-row">
            <input type="range" min={64} max={activeModel?.max_output_length ?? 4096} step={64}
              value={Math.min(config.maxTokens, activeModel?.max_output_length ?? 4096)}
              onChange={(e) => set("maxTokens", Number(e.target.value))} />
            <span className="range-val">{config.maxTokens}</span>
          </div>
        </div>

        <Toggle
          label="Stream responses"
          sub="Token-by-token output via SSE"
          checked={config.stream}
          onChange={(v) => set("stream", v)}
        />
        <Toggle
          label="JSON mode"
          sub={supportsJson ? "Force valid JSON output" : "Not supported by this model"}
          checked={config.jsonMode && supportsJson}
          disabled={!supportsJson}
          onChange={(v) => set("jsonMode", v)}
        />

        <div className="section-title">Tools {supportsTools ? "" : "(model has no tool support)"}</div>
        {config.tools.map((t, i) => (
          // Keyed by the tool's own id, not its index: the schema textarea below
          // is uncontrolled, so an index key would show the wrong schema after
          // deleting a tool above it.
          <div className="tool-card" key={t.id ?? i}>
            <div className="tc-head">
              <input type="text" value={t.function.name} placeholder="function_name"
                onChange={(e) => updateTool(i, { name: e.target.value })} />
              <button className="btn danger" onClick={() => setConfig((c) => ({ ...c, tools: c.tools.filter((_, j) => j !== i) }))}>✕</button>
            </div>
            <input type="text" value={t.function.description ?? ""} placeholder="description"
              style={{ marginBottom: 8 }} onChange={(e) => updateTool(i, { description: e.target.value })} />
            <textarea defaultValue={JSON.stringify(t.function.parameters ?? {}, null, 2)}
              onChange={(e) => updateToolParams(i, e.target.value)} spellCheck={false} />
            <div className="hint">JSON Schema for the function parameters.</div>
          </div>
        ))}
        <div className="btn-row">
          <button className="btn block ghost mini" disabled={!supportsTools}
            onClick={() => setConfig((c) => ({ ...c, tools: [...c.tools, { ...structuredClone(EXAMPLE_TOOL), id: newToolId() }] }))}>
            + Add tool
          </button>
          <button className="btn block ghost mini" onClick={loadExampleTools} title="Import tools from web/public/example-tools.json">
            ↓ Load example tools
          </button>
        </div>
        {toolMsg && <div className="hint" style={{ color: toolMsg.startsWith("Loaded") ? "var(--accent-2)" : "var(--muted-2)" }}>{toolMsg}</div>}

        <div className="section-title">Knowledge (RAG)</div>
        <Toggle
          label="Ground answers in knowledge"
          sub={docs.length ? `Retrieve from ${docs.length} doc${docs.length > 1 ? "s" : ""} via embeddings` : "Add a document to enable"}
          checked={config.useKnowledge && docs.length > 0}
          disabled={docs.length === 0}
          onChange={(v) => set("useKnowledge", v)}
        />
        {docs.map((d) => (
          <div className="tool-card" key={d.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</div>
              <div className="hint" style={{ margin: 0 }}>{d.chunks} chunks · {d.chars.toLocaleString()} chars</div>
            </div>
            <button className="btn danger" onClick={() => removeDoc(d.id)}>✕</button>
          </div>
        ))}
        <div className="field" style={{ marginTop: 10 }}>
          <input type="text" placeholder="Document name (optional)" value={docName}
            onChange={(e) => setDocName(e.target.value)} style={{ marginBottom: 8 }} />
          <textarea placeholder="Paste text to give your bot a knowledge base…" value={docText}
            onChange={(e) => setDocText(e.target.value)} style={{ minHeight: 80 }} />
          {kbError && <div className="hint" style={{ color: "var(--danger)" }}>{kbError}</div>}
          <button className="btn block ghost mini" style={{ marginTop: 8 }} disabled={adding || !docText.trim()} onClick={addDoc}>
            {adding ? "Embedding…" : "+ Add to knowledge base"}
          </button>
        </div>

        <div className="section-title">Voice</div>
        <Toggle
          label="Speak replies aloud"
          sub="Browser text-to-speech"
          checked={config.speak}
          onChange={(v) => set("speak", v)}
        />
        <div className="hint">
          {speechSupported() ? "Mic dictation available in the composer." : "Voice input not supported in this browser."}
          {" "}SCX-native audio (scx-tts/scx-stt) is gated on this tier.
        </div>

        <div className="section-title">Session</div>
        <div className="btn-row">
          <button className="btn block ghost" onClick={onReset}>Clear chat</button>
          <button className="btn block ghost" onClick={exportConfig}>Export</button>
        </div>
      </div>
      )}
      {authOn && (
        <div className="sidebar-foot">
          <button className="btn ghost sm block" onClick={logout}>Sign out</button>
        </div>
      )}
    </aside>
  );
}

/** Left rail for Runner mode: project folder + what the agents can do. */
function RunnerSidebar({ runner, status, statusError, onOpen, sessions }: {
  runner: RunnerSettings; status: AgentStatus | null; statusError: string | null; onOpen: (dir: string) => void;
  sessions: SessionNav;
}) {
  const [draft, setDraft] = useState(runner.directory);
  const [err, setErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => setDraft(runner.directory), [runner.directory]);

  async function open(dir = draft) {
    if (!dir.trim()) return;
    setChecking(true);
    setErr(null);
    try {
      onOpen(await agentCheckDirectory(dir));
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setChecking(false);
    }
  }

  const recent = runner.recent.filter((d) => d !== runner.directory);
  const scx = status?.models.filter((m) => m.id.startsWith("scx/")).length ?? 0;

  return (
    <div className="sidebar-body">
      <div className="section-title">Project</div>
      <div className="field">
        <form className="dir-row" onSubmit={(e) => { e.preventDefault(); open(); }}>
          <input type="text" className="mono" value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder="C:\code\my-project" spellCheck={false} />
          <button className="btn sm" type="submit" disabled={checking || !draft.trim() || draft === runner.directory}>Open</button>
        </form>
        {err && <div className="hint danger">{err}</div>}
        <div className="hint">The agent reads, edits and runs commands in this folder. Switching folders starts a new session.</div>
      </div>

      {recent.length > 0 && (
        <div className="field">
          <label>Recent</label>
          <div className="recent-list">
            {recent.map((d) => (
              <button key={d} className="recent-item" onClick={() => open(d)} title={d}>
                <span className="recent-name">{d.split(/[\\/]/).filter(Boolean).pop()}</span>
                <span className="recent-path mono">{d}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {runner.directory && <SessionList directory={runner.directory} nav={sessions} />}

      <div className="section-title">Agents</div>
      <div className="agent-info">
        <div className="ai-row"><span className="ai-name">build</span><span className="hint">edits &amp; runs</span></div>
        <div className="hint" style={{ margin: "2px 0 10px" }}>Every file edit and shell command waits for your approval.</div>
        <div className="ai-row"><span className="ai-name">plan</span><span className="hint">read-only</span></div>
        <div className="hint" style={{ margin: "2px 0 0" }}>Explores and reasons without changing anything.</div>
      </div>

      <div className="section-title">Engine</div>
      {statusError ? (
        <div className="hint danger">{statusError}</div>
      ) : (
        <div className="engine">
          <div><span className="muted">Agent</span><span>OpenCode</span></div>
          <div><span className="muted">Provider</span><span>SCX.ai · {scx} models</span></div>
          <div><span className="muted">Default</span><span className="mono">{status?.defaultModel ?? "…"}</span></div>
        </div>
      )}
    </div>
  );
}

/** Past chats in this project: click to resume, ✕ (twice) to delete. */
function SessionList({ directory, nav }: { directory: string; nav: SessionNav }) {
  const [list, setList] = useState<SessionSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let live = true;
    agentSessions(directory)
      .then((s) => { if (live) { setList(s); setErr(null); } })
      .catch((e) => live && setErr(String((e as Error).message ?? e)));
    return () => { live = false; };
  }, [directory, nav.version, nav.active]);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  async function remove(id: string) {
    if (confirming !== id) { setConfirming(id); return; }
    setConfirming(null);
    try {
      await agentDeleteSession(id, directory);
      if (nav.active === id) nav.open(null);
      setList((l) => l?.filter((s) => s.id !== id) ?? null);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }

  const shown = showAll ? list ?? [] : (list ?? []).slice(0, 8);
  return (
    <>
      <div className="section-title">Sessions</div>
      <button className="btn ghost sm block new-session" onClick={() => nav.open(null)}>+ New session</button>
      {err && <div className="hint danger">{err}</div>}
      {list && list.length === 0 && <div className="hint">No past sessions in this folder yet.</div>}
      <div className="session-list">
        {shown.map((s) => (
          <div key={s.id} className={"session-item" + (s.id === nav.active ? " on" : "")}>
            <button className="session-open" onClick={() => nav.open(s.id)} title={s.title}>
              <span className="session-title">{s.title || "Untitled session"}</span>
              <span className="session-meta">
                {timeAgo(s.updated)}
                {s.files > 0 && <> · <span className="adds">+{s.additions}</span> <span className="dels">−{s.deletions}</span></>}
              </span>
            </button>
            <button
              className={"session-del" + (confirming === s.id ? " confirm" : "")}
              onClick={() => remove(s.id)}
              title={confirming === s.id ? "Click again to delete" : "Delete session"}
              aria-label={confirming === s.id ? "Confirm delete" : "Delete session"}
            >
              {confirming === s.id ? "Delete?" : "✕"}
            </button>
          </div>
        ))}
      </div>
      {list && list.length > 8 && (
        <button className="btn ghost sm block" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show all ${list.length}`}
        </button>
      )}
    </>
  );
}

function timeAgo(ms?: number) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function Toggle({ label, sub, checked, onChange, disabled }: {
  label: string; sub?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <div className="toggle">
      <div className="tg-label">{label}{sub && <small>{sub}</small>}</div>
      <label className={"switch" + (disabled ? " disabled" : "")}>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span />
      </label>
    </div>
  );
}
