import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  agentCreateSession, agentPrompt, agentReplyPermission, agentAbort, agentDiff, openAgentEvents, agentAnswerQuestion,
  agentLoadSession, agentCommands, agentRunCommand, agentCompact, agentPending,
  type AgentEvent, type AgentStatus, type FileDiff, type Todo, type SlashCommand, type FileUpload, type StoredMessage,
} from "./agentApi";
import type { FilePart, MessagePart, PermissionRequest, ToolPart } from "../../shared/agent";
import { Markdown } from "./Markdown";
import { setFileRoots } from "./filelinks";
import { Composer, LOCAL_COMMANDS, type AgentName } from "./Composer";
import { formatBytes, formatTokens } from "./format";
import { TodoPanel } from "./TodoPanel";
import { BootSequence, TerminalBar, type BootLine } from "./Terminal";
import { FileTextIcon, ToolIcon } from "./icons";
import { DiffModal } from "./DiffModal";
import { QuestionCard, type QuestionReq } from "./QuestionCard";

type Part = MessagePart;

interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  parts: Part[];
  tokens?: StoredMessage["tokens"];
  cost?: number;
  model?: string;
  error?: string;
}
type PermReq = PermissionRequest;

const AGENT_BLURB: Record<AgentName, string> = {
  build: "Edits files and runs commands. You approve each change.",
  plan: "Read-only. Explores the code and writes a plan.",
};

/** The typed boot sequence shown on an empty session (the site's hero terminal). */
function bootLines(project: string, agent: AgentName): BootLine[] {
  return [
    { kind: "p", text: `./bxh --project ${project} --agent ${agent}`, pace: 26 },
    { kind: "out", text: "Loading project context..." },
    { kind: "out", text: AGENT_BLURB[agent], pace: 18 },
    { kind: "ok", text: "Agent ready ", ok: "OK" },
  ];
}

const SUGGESTIONS = [
  "Summarise the architecture of this project.",
  "Find and explain the main entry points.",
  "/init",
];

/** Within this many pixels of the bottom counts as "following" new output. */
const STICK_PX = 80;

interface Props {
  status: AgentStatus | null;
  statusError: string | null;
  directory: string;
  model: string;
  setModel: (m: string) => void;
  /** Session to open (from the session list); `n` changes on every request. */
  resume: { id: string | null; n: number } | null;
  /** Tell the shell which session is showing, and when the list may have changed. */
  onActiveSession: (id: string | null) => void;
  onSessionsChanged: () => void;
}

export function AgentPanel({
  status, statusError, directory, model, setModel, resume, onActiveSession, onSessionsChanged,
}: Props) {
  const [agent, setAgent] = useState<AgentName>("build");
  const [sessionID, setSessionID] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [perms, setPerms] = useState<PermReq[]>([]);
  const [questions, setQuestions] = useState<QuestionReq[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff[] | string | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  // Type-ahead queue: prompts entered while a turn is running, sent on idle.
  const [queued, setQueued] = useState<{ id: number; text: string; files: FileUpload[] }[]>([]);
  const queueRef = useRef<{ id: number; text: string; files: FileUpload[] }[]>([]);
  const qSeq = useRef(0);
  const turnActive = useRef(false); // a prompt/command is mid-flight (truthier than `busy` for gating)
  // The memoized event handler calls turn-end through this ref so it always runs
  // the latest logic (current model/agent/directory), never a stale closure.
  const endTurnRef = useRef<() => void>(() => {});

  const roleRef = useRef<Record<string, "user" | "assistant" | string>>({});
  const lastUserText = useRef("");
  const localSeq = useRef(0);
  const streamAbort = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    agentCommands(directory).then(setCommands).catch(() => {});
    // Paths the agent prints under the project (or /workspace in Docker) become download links.
    setFileRoots(directory, ["/workspace"]);
  }, [directory]);

  // --- scrolling: follow new output only while the user is at the bottom ---
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    stick.current = near;
    setAtBottom(near);
  }
  function scrollToBottom(smooth = true) {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }
  useEffect(() => {
    if (stick.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, perms, questions]);

  // --- transcript mutation helpers ----------------------------------------
  const upsert = useCallback((id: string, patch: (m: AgentMessage) => void) => {
    setMessages((prev) => {
      const next = prev.slice();
      let i = next.findIndex((m) => m.id === id);
      if (i === -1) {
        next.push({ id, role: "assistant", parts: [] });
        i = next.length - 1;
      }
      const copy = { ...next[i], parts: next[i].parts.slice() };
      patch(copy);
      next[i] = copy;
      return next;
    });
  }, []);

  const onEvent = useCallback((e: AgentEvent) => {
    switch (e.kind) {
      case "message":
        roleRef.current[e.messageID] = e.role;
        if (e.role === "assistant") {
          upsert(e.messageID, (m) => { m.tokens = e.tokens; m.cost = e.cost; m.model = e.model; });
        }
        break;
      case "text":
      case "reasoning": {
        // The user's own prompt streams back as a text part — we already show it.
        const role = roleRef.current[e.messageID];
        if (role === "user") break;
        if (!role && e.text.trim() === lastUserText.current.trim()) break;
        const pid = e.partID ?? `${e.kind}-${e.messageID}`;
        upsert(e.messageID, (m) => {
          const i = m.parts.findIndex((p) => p.type === e.kind && "id" in p && p.id === pid);
          const part = { type: e.kind, id: pid, text: e.text } as Part;
          if (i === -1) m.parts.push(part);
          else m.parts[i] = part;
        });
        break;
      }
      case "tool":
        upsert(e.messageID, (m) => {
          const i = m.parts.findIndex((p) => p.type === "tool" && p.callID === e.callID);
          const part: ToolPart = { type: "tool", callID: e.callID, tool: e.tool, status: e.status, title: e.title, input: e.input, output: e.output, error: e.error };
          if (i === -1) m.parts.push(part);
          else m.parts[i] = { ...(m.parts[i] as ToolPart), ...part };
        });
        break;
      case "todo":
        setTodos(e.todos);
        break;
      case "session":
        onSessionsChanged(); // e.g. OpenCode generated a title
        break;
      case "permission":
        setPerms((p) => (p.some((x) => x.permissionID === e.permissionID) ? p : [...p, e]));
        break;
      case "permission-replied":
        setPerms((p) => p.filter((x) => x.permissionID !== e.permissionID));
        break;
      case "question":
        // OpenCode may announce the same question in two event formats.
        setQuestions((q) => (q.some((x) => x.requestID === e.requestID) ? q : [...q, { requestID: e.requestID, questions: e.questions }]));
        break;
      case "question-closed":
        setQuestions((q) => q.filter((x) => x.requestID !== e.requestID));
        break;
      case "idle":
        onSessionsChanged();
        endTurnRef.current();
        break;
      case "error":
        setError(e.message);
        endTurnRef.current();
        break;
    }
  }, [upsert, onSessionsChanged]);

  // --- session lifecycle ---------------------------------------------------
  function resetView() {
    streamAbort.current?.abort();
    streamAbort.current = null;
    setSessionID(null);
    setMessages([]);
    setPerms([]);
    setQuestions([]);
    setTodos([]);
    setError(null);
    setNotice(null);
    setBusy(false);
    queueRef.current = [];
    syncQueue();
    turnActive.current = false;
    roleRef.current = {};
    stick.current = true;
    setAtBottom(true);
  }

  function attachStream(id: string) {
    streamAbort.current?.abort();
    const ctrl = new AbortController();
    streamAbort.current = ctrl;
    // Fire-and-forget; the stream lives (reconnecting as needed) as long as
    // the session is shown. After a reconnect, re-check what is waiting on us.
    openAgentEvents(id, directory, onEvent, ctrl.signal, () => restorePending(id, ctrl)).catch((err) => {
      if (err?.name !== "AbortError") setError(String(err?.message ?? err));
    });
    restorePending(id, ctrl);
  }

  /**
   * Catch up on approvals/questions raised while no stream was attached (page
   * reload, dropped connection) — otherwise the agent sits blocked with no
   * visible card.
   */
  function restorePending(id: string, ctrl: AbortController) {
    agentPending(id, directory).then(({ permissions, questions: qs }) => {
      if (ctrl.signal.aborted) return;
      if (permissions.length) {
        setPerms((cur) => {
          const have = new Set(cur.map((p) => p.permissionID));
          return [...cur, ...permissions.filter((p) => !have.has(p.permissionID))];
        });
        setBusy(true);
      }
      if (qs.length) {
        setQuestions((cur) => {
          const have = new Set(cur.map((q) => q.requestID));
          return [...cur, ...qs.filter((q) => !have.has(q.requestID)).map((q) => ({ requestID: q.requestID, questions: q.questions }))];
        });
        setBusy(true);
      }
    }).catch(() => {});
  }

  async function ensureSession(): Promise<string> {
    if (sessionID) return sessionID;
    const s = await agentCreateSession(directory);
    setSessionID(s.id);
    onActiveSession(s.id);
    attachStream(s.id);
    return s.id;
  }

  function newSession() {
    resetView();
    onActiveSession(null);
  }

  // Open a past session when the sidebar asks for one.
  useEffect(() => {
    if (!resume) return;
    if (!resume.id) { newSession(); return; }
    const id = resume.id;
    resetView();
    setLoading(true);
    agentLoadSession(id, directory)
      .then(({ messages: stored, todos: storedTodos }) => {
        for (const m of stored) roleRef.current[m.id] = m.role;
        setMessages(stored.map(fromStored));
        setTodos(storedTodos ?? []);
        setSessionID(id);
        onActiveSession(id);
        attachStream(id);
        requestAnimationFrame(() => scrollToBottom(false));
      })
      .catch((e) => setError(String((e as Error).message ?? e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume?.n]);

  // --- sending: prompts, slash commands ------------------------------------
  const syncQueue = () => setQueued([...queueRef.current]);

  /** Public entry from the composer: run now if idle, otherwise queue it. */
  function send(raw: string, files: FileUpload[] = []) {
    const text = raw.trim();
    if (!text && !files.length) return;
    if (turnActive.current) {
      queueRef.current.push({ id: qSeq.current++, text: raw, files });
      syncQueue();
      scrollToBottom();
      return;
    }
    void sendNow(raw, files);
  }

  function cancelQueued(id: number) {
    queueRef.current = queueRef.current.filter((q) => q.id !== id);
    syncQueue();
  }

  /** When the turn ends, send the next queued prompt (if any). */
  function dequeue() {
    if (turnActive.current) return;
    const next = queueRef.current.shift();
    syncQueue();
    if (next) void sendNow(next.text, next.files);
  }

  // Turn-end: OpenCode can emit both `error` and `idle` for one turn, so collapse
  // them into a single dequeue with a one-frame debounce.
  const dequeueScheduled = useRef(false);
  function endTurn() {
    turnActive.current = false;
    setBusy(false);
    if (dequeueScheduled.current) return;
    dequeueScheduled.current = true;
    requestAnimationFrame(() => { dequeueScheduled.current = false; dequeue(); });
  }
  endTurnRef.current = endTurn; // keep the event-stream handler pointed at current logic

  async function sendNow(raw: string, files: FileUpload[] = []) {
    const text = raw.trim();
    setError(null);
    setNotice(null);
    scrollToBottom();

    const cmd = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
    if (cmd && !files.length) {
      await runSlash(cmd[1].toLowerCase(), (cmd[2] ?? "").trim());
      if (!turnActive.current) dequeue(); // local command finished instantly — keep draining
      return;
    }

    try {
      turnActive.current = true;
      const sid = await ensureSession();
      lastUserText.current = text;
      const id = `local-${localSeq.current++}`;
      const fileParts: FilePart[] = files.map((f, i) => ({ type: "file", id: `${id}-f${i}`, filename: f.name, mime: f.mime, url: f.preview, size: f.size }));
      setMessages((prev) => [...prev, { id, role: "user", parts: [...(text ? [{ type: "text" as const, id, text }] : []), ...fileParts] }]);
      setBusy(true);
      const activeModel = status?.models.find((m) => m.id === model);
      await agentPrompt({
        sessionID: sid, text, agent, model, directory,
        files: files.map(({ name, mime, data }) => ({ name, mime, data })),
        inlineImages: Boolean(activeModel?.images),
      });
    } catch (e) {
      setError(String((e as Error).message ?? e));
      endTurn();
    }
  }

  async function runSlash(name: string, args: string) {
    switch (name) {
      case "new":
        newSession();
        return;
      case "plan":
      case "build":
        setAgent(name);
        setNotice(`Switched to the ${name} agent.`);
        return;
      case "help": {
        const all = [...LOCAL_COMMANDS, ...commands.filter((c) => !LOCAL_COMMANDS.some((l) => l.name === c.name))];
        setNotice(all.map((c) => `/${c.name}${c.hint ? " " + c.hint : ""} — ${c.description}`).join("\n"));
        return;
      }
      case "model": {
        const q = args.toLowerCase();
        const list = status?.models ?? [];
        const hit = q && (list.find((m) => m.id.toLowerCase() === q || m.name.toLowerCase() === q)
          ?? list.find((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)));
        if (!hit) {
          setError(q ? `No model matches “${args}”.` : "Usage: /model <name>, e.g. /model kimi");
          return;
        }
        setModel(hit.id);
        setNotice(`Model: ${hit.name}`);
        return;
      }
      case "compact":
        if (!sessionID) { setError("Nothing to compact yet."); return; }
        try {
          turnActive.current = true;
          setBusy(true);
          await agentCompact(sessionID, directory, model);
          setNotice("Compacting the conversation…");
        } catch (e) {
          setError(String((e as Error).message ?? e));
          endTurn();
        }
        return;
    }
    if (!commands.some((c) => c.name === name)) {
      setError(`Unknown command /${name}. Type / to see the list.`);
      return;
    }
    try {
      const sid = await ensureSession();
      const id = `local-${localSeq.current++}`;
      const shown = `/${name}${args ? " " + args : ""}`;
      lastUserText.current = shown;
      setMessages((prev) => [...prev, { id, role: "user", parts: [{ type: "text", id, text: shown }] }]);
      turnActive.current = true;
      setBusy(true);
      await agentRunCommand({ sessionID: sid, command: name, arguments: args, agent, model, directory });
    } catch (e) {
      setError(String((e as Error).message ?? e));
      endTurn();
    }
  }

  async function reply(p: PermReq, response: "once" | "always" | "reject") {
    setPerms((cur) => cur.filter((x) => x.permissionID !== p.permissionID));
    try {
      await agentReplyPermission({ sessionID: p.sessionID, permissionID: p.permissionID, response, directory });
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }

  async function answerQuestion(q: QuestionReq, answers: string[][] | null) {
    setQuestions((cur) => cur.filter((x) => x.requestID !== q.requestID));
    try {
      await agentAnswerQuestion(answers ? { requestID: q.requestID, answers, directory } : { requestID: q.requestID, reject: true, directory });
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }

  async function stop() {
    // Stop halts the current turn and clears anything queued behind it.
    queueRef.current = [];
    syncQueue();
    turnActive.current = false;
    setBusy(false);
    if (sessionID) await agentAbort(sessionID, directory).catch(() => {});
  }

  async function viewDiff() {
    if (!sessionID) return;
    const d = await agentDiff(sessionID, directory);
    setDiff(Array.isArray(d) ? (d as FileDiff[]) : typeof d === "string" ? d : d ? JSON.stringify(d, null, 2) : []);
  }

  useEffect(() => () => streamAbort.current?.abort(), []);

  const projectName = directory.split(/[\\/]/).filter(Boolean).pop() ?? directory;
  const turnTokens = useMemo(
    () => messages.reduce((n, m) => n + (m.tokens?.input ?? 0) + (m.tokens?.output ?? 0), 0),
    [messages],
  );
  const waiting = perms.length > 0 || questions.length > 0;

  return (
    <main className="main">
      <TerminalBar title={`bugxhunter@redteam: ~/${projectName}`} tooltip={directory}>
        <span className={"status-pill" + (busy ? " live" : "")}>
          <span className="dot" />{busy ? (waiting ? "waiting for you" : "running") : sessionID ? "idle" : "ready"}
        </span>
        {turnTokens > 0 && <span className="token-pill">{formatTokens(turnTokens)} tokens</span>}
        <button className="btn ghost sm" onClick={viewDiff} disabled={!sessionID}>changes</button>
        <button className="btn ghost sm" onClick={newSession} disabled={busy}>new_session</button>
      </TerminalBar>

      <div className="transcript-wrap">
      <div className="transcript grid-bg" ref={scrollRef} onScroll={onScroll}>
        <div className="transcript-inner">
          {loading && <p className="muted center mono">Loading session…</p>}
          {!loading && messages.length === 0 && (
            <div className="empty-state">
              <BootSequence key={`${projectName}:${agent}`} lines={bootLines(projectName, agent)} />
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button className="chip" key={s} onClick={() => (s.startsWith("/") ? send(s) : setDraft(s))}>
                    {s === "/init" ? "/init — create AGENTS.md, the project's memory for future sessions" : s}
                  </button>
                ))}
              </div>
              {statusError && <div className="error-banner">{statusError}</div>}
            </div>
          )}

          {messages.map((m) => <AgentRow key={m.id} msg={m} />)}

          {perms.map((p) => (
            <div className="perm-card" key={p.permissionID}>
              <div className="perm-title">Approval needed</div>
              <div className="perm-body">
                <span className="perm-type">{p.permType ?? "action"}</span>{" "}
                {p.title ?? (Array.isArray(p.pattern) ? p.pattern.join(", ") : p.pattern) ?? ""}
              </div>
              <div className="perm-actions">
                <button className="btn primary sm" onClick={() => reply(p, "once")}>Approve</button>
                <button className="btn sm" onClick={() => reply(p, "always")}>Always allow</button>
                <button className="btn sm danger-outline" onClick={() => reply(p, "reject")}>Reject</button>
              </div>
            </div>
          ))}

          {questions.map((q) => (
            <QuestionCard key={q.requestID} req={q} onAnswer={(a) => answerQuestion(q, a)} onDismiss={() => answerQuestion(q, null)} />
          ))}

          {busy && !waiting && <div className="working"><span /><span /><span /></div>}

          {queued.map((q) => (
            <div className="msg user" key={q.id}>
              <div className="user-col">
                <div className="bubble user-bubble queued-bubble">
                  {q.text || `(${q.files.length} file${q.files.length > 1 ? "s" : ""})`}
                </div>
                <div className="queued-label">queued · <button className="link-btn" onClick={() => cancelQueued(q.id)}>cancel</button></div>
              </div>
            </div>
          ))}

          {notice && <div className="notice">{notice}</div>}
          {error && <div className="error-banner">{error}</div>}
        </div>
      </div>

      {!atBottom && (
        <button className="jump-btn" onClick={() => scrollToBottom()} aria-label="Scroll to latest">↓ latest</button>
      )}
      </div>

      <div className="composer">
        <TodoPanel todos={todos} />
        <Composer
          agent={agent}
          setAgent={setAgent}
          model={model}
          setModel={setModel}
          models={status?.models ?? []}
          commands={commands}
          busy={busy}
          onSend={send}
          onStop={stop}
          draft={draft}
          onDraftUsed={useCallback(() => setDraft(null), [])}
        />
      </div>

      {diff !== null && <DiffModal diff={diff} onClose={() => setDiff(null)} />}
    </main>
  );
}

/** Stored message (from the server) -> transcript message. */
function fromStored(m: StoredMessage): AgentMessage {
  return { id: m.id, role: m.role, parts: m.parts as Part[], tokens: m.tokens, cost: m.cost, model: m.model, error: m.error };
}

function AgentRow({ msg }: { msg: AgentMessage }) {
  if (msg.role === "user") {
    const text = msg.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    const files = msg.parts.filter((p): p is FilePart => p.type === "file");
    return (
      <div className="msg user">
        <div className="user-col">
          {files.length > 0 && (
            <div className="attach-row right">
              {files.map((f) => (
                <span className="attach-chip" key={f.id} title={f.filename}>
                  {f.url ? <img src={f.url} alt="" /> : <span className="attach-icon"><FileTextIcon /></span>}
                  <span className="attach-name">{f.filename}</span>
                  {f.size ? <span className="attach-size">{formatBytes(f.size)}</span> : null}
                </span>
              ))}
            </div>
          )}
          {text && <div className="bubble user-bubble">{text}</div>}
        </div>
      </div>
    );
  }
  if (!msg.parts.length && !msg.error) return null;
  return (
    <div className="msg assistant">
      <div className="avatar" aria-hidden>▶</div>
      <div className="msg-body">
        {msg.parts.map((p, i) =>
          p.type === "tool" ? <ToolCard key={p.callID} t={p} />
          : p.type === "reasoning" ? <Reasoning key={p.id} text={p.text} />
          : p.type === "text" ? <Markdown key={p.id} text={p.text} files />
          : <span key={p.id ?? i} />,
        )}
        {msg.error && <div className="error-banner">{msg.error}</div>}
        {msg.tokens && (msg.tokens.output ?? 0) > 0 && (
          <div className="msg-meta">
            {msg.model && <span>{msg.model}</span>}
            <span>{formatTokens(msg.tokens.input ?? 0)} in · {formatTokens(msg.tokens.output ?? 0)} out</span>
            {msg.cost ? <span>${msg.cost.toFixed(4)}</span> : null}
          </div>
        )}
      </div>
    </div>
  );
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="reasoning">
      <button className="reasoning-toggle" onClick={() => setOpen((v) => !v)}>
        <span className={"chev" + (open ? " open" : "")}>›</span> Thinking
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  );
}


function ToolCard({ t }: { t: ToolPart }) {
  const [open, setOpen] = useState(false);
  const summary = t.title || (t.input ? String(Object.values(t.input)[0] ?? "") : "");
  const hasBody = Boolean(t.output || t.error);
  return (
    <div className={"tool s-" + t.status}>
      <button className="tool-head" onClick={() => hasBody && setOpen((v) => !v)} disabled={!hasBody}>
        <span className="tool-icon"><ToolIcon tool={t.tool} /></span>
        <span className="tool-name">{t.tool}</span>
        <span className="tool-summary">{summary.slice(0, 120)}</span>
        <span className="tool-state">{t.status === "running" || t.status === "pending" ? <span className="spin" /> : t.status === "error" ? "failed" : ""}</span>
        {hasBody && <span className={"chev" + (open ? " open" : "")}>›</span>}
      </button>
      {open && hasBody && <pre className="tool-output">{t.error ? "error: " + t.error : t.output}</pre>}
    </div>
  );
}
