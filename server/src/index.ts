/**
 * Open Runner backend.
 *
 * A thin Express server in front of OpenCode (the coding agent) and the SCX
 * platform (the playground chat). The SCX API key stays server-side; the
 * browser only ever talks to this server. Streams are forwarded as
 * Server-Sent Events.
 */
import express from "express";
import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCXClient, SCXError, type ChatParams } from "./scx.js";
import { KnowledgeBase, buildContextBlock } from "./rag.js";
import {
  getClient, serverUrl, resolveDirectory, listAgentModels, toUiEvent, toUiMessages, parseModelId,
  DEFAULT_DIRECTORY, DEFAULT_MODEL, REMOTE_URL, REPO_ROOT,
} from "./opencode.js";
import { mountAuth, authRequired } from "./auth.js";
import { audit, followOpencode, LOG_DIR } from "./audit.js";
import { saveAttachments, type Attachment } from "./attachments.js";
import { startEgressProxy, egressEvents, decide, listPending, listRules, removeRule, type Decision } from "./egress.js";

// Optional repo-root .env (server runs from /server).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

/** The key `opencode auth login` stored for the scx provider, if any. */
function opencodeAuthKey(): string {
  try {
    const file = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
    return JSON.parse(fs.readFileSync(file, "utf8"))?.scx?.key ?? "";
  } catch {
    return "";
  }
}

const API_KEY = process.env.SCX_API ?? process.env.SCX_API_KEY ?? opencodeAuthKey();
const BASE_URL = process.env.SCX_BASE_URL ?? "https://api.scx.ai/v1";
const PORT = Number(process.env.PORT ?? 8790);

if (!API_KEY) {
  console.error(
    "\n[fatal] No SCX API key found. Run `opencode auth login` (provider id: scx), or set SCX_API in .env.\n",
  );
  process.exit(1);
}

const scx = new SCXClient({ apiKey: API_KEY, baseUrl: BASE_URL });
const kb = new KnowledgeBase(scx); // in-memory RAG store (POC scope)
const app = express();
app.disable("x-powered-by");

/**
 * SCX proxy for the sandboxed agent (Docker). The agent container has no
 * internet and no SCX key: its OpenCode talks to this route with a shared
 * proxy token, and we forward chat/model calls to SCX with the real key.
 * So the key never enters the container the agent's shell runs in.
 * Mounted before the JSON parser so request bodies pass through untouched.
 */
const PROXY_TOKEN = process.env.SCX_PROXY_TOKEN ?? "";
const PROXY_PATHS = new Set(["/chat/completions", "/models"]);
if (PROXY_TOKEN) {
  app.all("/scx/v1/*", async (req, res) => {
    const sub = req.path.slice("/scx/v1".length);
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${PROXY_TOKEN}`) return res.status(401).json({ error: { message: "bad proxy token" } });
    if (!PROXY_PATHS.has(sub)) return res.status(404).json({ error: { message: `not proxied: ${sub}` } });
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const ctrl = new AbortController();
      res.on("close", () => ctrl.abort());
      const upstream = await fetch(BASE_URL + sub + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""), {
        method: req.method,
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": req.headers["content-type"] ?? "application/json",
          Accept: req.headers.accept ?? "*/*",
        },
        body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
        signal: ctrl.signal,
      });
      res.status(upstream.status);
      const type = upstream.headers.get("content-type");
      if (type) res.setHeader("Content-Type", type);
      if (!upstream.body) return res.end();
      for await (const chunk of upstream.body as any) res.write(chunk);
      res.end();
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: { message: String((e as Error).message ?? e) } });
      else res.end();
    }
  });
}

// Prompts can carry attachments (base64), so allow larger bodies there.
app.use("/api/agent/prompt", express.json({ limit: "40mb" }));
app.use(express.json({ limit: "4mb" }));
mountAuth(app);

const sendError = (res: express.Response, e: unknown) => {
  if (e instanceof SCXError) {
    return res.status(e.status).json({ error: { message: e.message, type: e.type } });
  }
  const status = (e as { status?: number })?.status;
  if (status) return res.status(status).json({ error: { message: (e as Error).message } });
  console.error("[server error]", e);
  return res.status(500).json({ error: { message: String((e as Error)?.message ?? e) } });
};

app.get("/api/health", (_req, res) => res.json({ ok: true, baseUrl: BASE_URL }));

/** List models (with capabilities + pricing) for the playground's model picker. */
app.get("/api/models", async (_req, res) => {
  try {
    res.json({ data: await scx.listModels() });
  } catch (e) {
    sendError(res, e);
  }
});

/**
 * Chat endpoint. If `stream: true`, forwards SCX's SSE stream to the client.
 * Otherwise returns the full completion JSON.
 */
app.post("/api/chat", async (req, res) => {
  const { rag, ragTopK, ...params } = req.body as ChatParams & { rag?: boolean; ragTopK?: number };
  let retrieved: { text: string; score: number; doc: string }[] = [];
  try {
    // RAG: retrieve context for the latest user turn and inject it as a system preamble.
    if (rag && kb.size) {
      const lastUser = [...params.messages].reverse().find((m) => m.role === "user");
      const query = typeof lastUser?.content === "string" ? lastUser.content : "";
      if (query) {
        retrieved = await kb.search(query, ragTopK ?? 4);
        const block = buildContextBlock(retrieved);
        if (block) {
          const sys = params.messages.find((m) => m.role === "system");
          if (sys && typeof sys.content === "string") sys.content = `${sys.content}\n\n${block}`;
          else params.messages.unshift({ role: "system", content: block });
        }
      }
    }
    if (params.stream) {
      const upstream = await scx.chatStreamResponse(params);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      // Surface RAG sources to the client before the model tokens stream in.
      if (retrieved.length) {
        const sources = retrieved.map((r) => ({ doc: r.doc, score: Number(r.score.toFixed(3)) }));
        res.write(`data: ${JSON.stringify({ scx_sources: sources })}\n\n`);
      }

      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      req.on("close", () => reader.cancel().catch(() => {}));
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
      res.end();
    } else {
      res.json(await scx.chat(params));
    }
  } catch (e) {
    // If headers already sent (mid-stream), emit an SSE error event instead.
    if (res.headersSent) {
      const msg = e instanceof SCXError ? e.message : String((e as Error)?.message ?? e);
      res.write(`data: ${JSON.stringify({ error: { message: msg } })}\n\n`);
      res.end();
    } else {
      sendError(res, e);
    }
  }
});

/** Embeddings passthrough. */
app.post("/api/embeddings", async (req, res) => {
  try {
    res.json(await scx.embeddings(req.body));
  } catch (e) {
    sendError(res, e);
  }
});

// --- Knowledge base (embeddings-backed RAG) -------------------------------

app.get("/api/kb", (_req, res) => res.json({ docs: kb.list() }));

app.post("/api/kb", async (req, res) => {
  try {
    const { name, text } = req.body as { name?: string; text?: string };
    if (!text?.trim()) return res.status(400).json({ error: { message: "text is required" } });
    const doc = await kb.addDocument(name ?? "", text);
    res.json({ id: doc.id, name: doc.name, chunks: doc.chunks.length, chars: doc.chars, docs: kb.list() });
  } catch (e) {
    sendError(res, e);
  }
});

app.delete("/api/kb/:id", (req, res) => {
  kb.remove(req.params.id);
  res.json({ docs: kb.list() });
});

app.delete("/api/kb", (_req, res) => {
  kb.clear();
  res.json({ docs: kb.list() });
});

// --- OpenCode agent --------------------------------------------------------
// The build agent reads/writes files and runs commands in the chosen project
// folder, so edits flow through the permission endpoints below.

/** hey-api style result -> data, throwing on error. */
function unwrap<T>(r: { data?: T; error?: unknown }): T {
  if (r?.error) throw new SCXError(400, typeof r.error === "string" ? r.error : JSON.stringify(r.error));
  return r.data as T;
}

/** Boot the agent server and report defaults + the models it can use. */
app.get("/api/agent/status", async (_req, res) => {
  try {
    const directory = await resolveDirectory(DEFAULT_DIRECTORY);
    const client = await getClient(directory);
    res.json({
      ready: true,
      url: await serverUrl(),
      directory,
      defaultModel: DEFAULT_MODEL,
      models: await listAgentModels(client),
    });
  } catch (e) {
    sendError(res, e);
  }
});

/** Check a project folder exists before the UI switches to it. */
app.get("/api/agent/directory", async (req, res) => {
  try {
    res.json({ directory: await resolveDirectory(req.query.directory) });
  } catch (e) {
    sendError(res, e);
  }
});

/** Create a fresh agent session in a project folder. */
app.post("/api/agent/session", async (req, res) => {
  try {
    const directory = await resolveDirectory(req.body?.directory);
    const client = await getClient(directory);
    const r = await client.session.create({
      // No title: OpenCode then names the session from its first prompt.
      body: req.body?.title ? { title: String(req.body.title) } : {},
      query: { directory },
    });
    const session = unwrap<any>(r);
    res.json({ id: session.id, directory });
  } catch (e) {
    sendError(res, e);
  }
});

/** Send a prompt to an agent (default: build). Output streams via /events. */
app.post("/api/agent/prompt", async (req, res) => {
  try {
    const { sessionID, text = "", agent = "build", model, directory: dir, files = [], inlineImages = true } = req.body as {
      sessionID?: string; text?: string; agent?: string; model?: string; directory?: string; files?: Attachment[];
      inlineImages?: boolean;
    };
    if (!sessionID || (!text.trim() && !files.length)) {
      return res.status(400).json({ error: { message: "sessionID and text (or files) are required" } });
    }
    const directory = await resolveDirectory(dir);
    const client = await getClient(directory);
    const attached = files.length ? saveAttachments(directory, files, inlineImages) : null;
    const prompt = (text.trim() || "See the attached file(s).") + (attached?.note ?? "");
    await client.session.promptAsync({
      path: { id: sessionID },
      query: { directory },
      body: {
        agent,
        model: parseModelId(model ?? DEFAULT_MODEL),
        parts: [{ type: "text", text: prompt }, ...((attached?.parts ?? []) as any[])],
      },
    });
    audit("prompt", { directory, session: sessionID, agent, model: model ?? DEFAULT_MODEL, text, attachments: attached?.saved });
    res.json({ ok: true, attachments: attached?.saved ?? [] });
  } catch (e) {
    sendError(res, e);
  }
});

/** Past sessions in a project folder, newest first. */
app.get("/api/agent/sessions", async (req, res) => {
  try {
    const directory = await resolveDirectory(req.query.directory);
    const r = await fetch(`${await serverUrl()}/session?directory=${encodeURIComponent(directory)}&roots=true&limit=100`);
    if (!r.ok) throw new SCXError(r.status, await r.text());
    const list = ((await r.json()) as any[])
      .filter((s) => !s.parentID && s.directory === directory)
      .map((s) => ({
        id: s.id, title: s.title, created: s.time?.created, updated: s.time?.updated ?? s.time?.created,
        files: s.summary?.files ?? 0, additions: s.summary?.additions ?? 0, deletions: s.summary?.deletions ?? 0,
      }))
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    res.json({ sessions: list });
  } catch (e) {
    sendError(res, e);
  }
});

/** A session's full history, shaped like the live event stream. */
app.get("/api/agent/session/:id/messages", async (req, res) => {
  try {
    const directory = await resolveDirectory(req.query.directory);
    const client = await getClient(directory);
    const msgs = unwrap<any[]>(await client.session.messages({ path: { id: req.params.id }, query: { directory } }));
    const todo = await fetch(`${await serverUrl()}/session/${encodeURIComponent(req.params.id)}/todo?directory=${encodeURIComponent(directory)}`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
    res.json({ messages: toUiMessages(msgs ?? []), todos: todo });
  } catch (e) {
    sendError(res, e);
  }
});

app.delete("/api/agent/session/:id", async (req, res) => {
  try {
    const directory = await resolveDirectory(req.query.directory);
    const client = await getClient(directory);
    unwrap(await client.session.delete({ path: { id: req.params.id }, query: { directory } }));
    audit("session.deleted", { directory, session: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    sendError(res, e);
  }
});

/** OpenCode's slash commands (built-in + the project's own). */
app.get("/api/agent/commands", async (req, res) => {
  try {
    const directory = await resolveDirectory(req.query.directory);
    const r = await fetch(`${await serverUrl()}/command?directory=${encodeURIComponent(directory)}`);
    const list = r.ok ? ((await r.json()) as any[]) : [];
    res.json({
      commands: list
        .filter((c) => c.source !== "skill")
        .map((c) => ({ name: c.name, description: c.description ?? "", hint: (c.hints ?? []).includes("$ARGUMENTS") ? "[arguments]" : "" })),
    });
  } catch (e) {
    sendError(res, e);
  }
});

/** Run an OpenCode slash command (e.g. /init, /review). Output streams via /events. */
app.post("/api/agent/command", async (req, res) => {
  try {
    const { sessionID, command, arguments: args = "", agent = "build", model, directory: dir } = req.body as {
      sessionID?: string; command?: string; arguments?: string; agent?: string; model?: string; directory?: string;
    };
    if (!sessionID || !command) return res.status(400).json({ error: { message: "sessionID and command required" } });
    const directory = await resolveDirectory(dir);
    audit("command", { directory, session: sessionID, command, arguments: args, agent, model: model ?? DEFAULT_MODEL });
    // The command runs a full agent turn; don't hold the HTTP request open for it.
    fetch(`${await serverUrl()}/session/${encodeURIComponent(sessionID)}/command?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, arguments: args, agent, model: model ?? DEFAULT_MODEL }),
    }).then(async (r) => {
      if (!r.ok) audit("error", { directory, session: sessionID, command, error: (await r.text()).slice(0, 500) });
    }).catch((e) => audit("error", { directory, session: sessionID, command, error: String(e) }));
    res.json({ ok: true });
  } catch (e) {
    sendError(res, e);
  }
});

/** Compact the conversation (summarise it to free up context). */
app.post("/api/agent/compact", async (req, res) => {
  try {
    const { sessionID, model, directory: dir } = req.body as { sessionID?: string; model?: string; directory?: string };
    if (!sessionID) return res.status(400).json({ error: { message: "sessionID required" } });
    const directory = await resolveDirectory(dir);
    const m = parseModelId(model ?? DEFAULT_MODEL)!;
    audit("compact", { directory, session: sessionID });
    fetch(`${await serverUrl()}/session/${encodeURIComponent(sessionID)}/summarize?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerID: m.providerID, modelID: m.modelID }),
    }).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    sendError(res, e);
  }
});

/**
 * Approvals and questions currently waiting on a session. The browser fetches
 * this when it (re)attaches to a session, so a prompt raised before the page
 * loaded — or while the event stream was briefly down — still shows up instead
 * of leaving the agent silently blocked.
 */
app.get("/api/agent/pending", async (req, res) => {
  try {
    const sessionID = String(req.query.sessionID || "");
    const directory = await resolveDirectory(req.query.directory);
    const base = await serverUrl();

    const permsRaw = await fetch(`${base}/permission`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const permissions = (permsRaw as any[])
      .filter((p) => !sessionID || p.sessionID === sessionID)
      .map((p) => ({
        kind: "permission",
        sessionID: p.sessionID,
        permissionID: p.id,
        permType: p.permission ?? p.type,
        title: p.metadata?.command ?? p.title,
        pattern: p.patterns ?? p.pattern,
        callID: p.callID,
      }));

    const qRaw = sessionID
      ? await fetch(`${base}/api/session/${encodeURIComponent(sessionID)}/question`)
          .then((r) => (r.ok ? r.json() : { data: [] }))
          .catch(() => ({ data: [] }))
      : { data: [] };
    const questions = ((qRaw as any).data ?? []).map((q: any) => ({
      kind: "question",
      sessionID: q.sessionID,
      requestID: q.id,
      questions: q.questions ?? [],
      callID: q.tool?.callID,
    }));

    res.json({ permissions, questions });
  } catch (e) {
    sendError(res, e);
  }
});

/** Reply to a pending permission request (once | always | reject). */
app.post("/api/agent/permission", async (req, res) => {
  try {
    const { sessionID, permissionID, response, directory: dir } = req.body as {
      sessionID?: string; permissionID?: string; response?: "once" | "always" | "reject"; directory?: string;
    };
    if (!sessionID || !permissionID || !response) {
      return res.status(400).json({ error: { message: "sessionID, permissionID, response required" } });
    }
    const directory = await resolveDirectory(dir);
    const client = await getClient(directory);
    unwrap(
      await client.postSessionIdPermissionsPermissionId({
        path: { id: sessionID, permissionID },
        query: { directory },
        body: { response },
      }),
    );
    res.json({ ok: true });
  } catch (e) {
    sendError(res, e);
  }
});

// --- Approval-gated internet access (Docker) -------------------------------
// The sandboxed agent reaches the internet only through the egress proxy;
// each new host waits for a decision made here.

const EGRESS_PORT = Number(process.env.EGRESS_PROXY_PORT ?? 0);
if (EGRESS_PORT) startEgressProxy(EGRESS_PORT);

// Audit log of agent activity (see audit.ts), fed by OpenCode's event stream.
if (LOG_DIR) serverUrl().then(followOpencode).catch((e) => console.error("[audit] not following OpenCode:", e));

app.get("/api/egress/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ kind: "snapshot", enabled: Boolean(EGRESS_PORT), pending: listPending(), rules: listRules() });
  const onPending = (r: unknown) => send({ kind: "pending", request: r });
  const onResolved = (r: unknown) => send({ kind: "resolved", ...(r as object) });
  const onRules = (r: unknown) => send({ kind: "rules", rules: r });
  egressEvents.on("pending", onPending);
  egressEvents.on("resolved", onResolved);
  egressEvents.on("rules", onRules);
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    egressEvents.off("pending", onPending);
    egressEvents.off("resolved", onResolved);
    egressEvents.off("rules", onRules);
  });
});

app.post("/api/egress/decide", (req, res) => {
  const { host, decision } = req.body as { host?: string; decision?: Decision };
  if (!host || !["session", "always", "deny"].includes(decision ?? "")) {
    return res.status(400).json({ error: { message: "host and decision (session|always|deny) required" } });
  }
  decide(host, decision!);
  res.json({ ok: true, rules: listRules() });
});

app.delete("/api/egress/rules/:host", (req, res) => {
  removeRule(req.params.host);
  res.json({ ok: true, rules: listRules() });
});

/**
 * Answer (or dismiss) a question the agent asked with its `question` tool.
 * `answers` holds one array of chosen labels / typed text per question.
 */
app.post("/api/agent/question", async (req, res) => {
  try {
    const { requestID, answers, reject, directory: dir } = req.body as {
      requestID?: string; answers?: string[][]; reject?: boolean; directory?: string;
    };
    if (!requestID || (!reject && !Array.isArray(answers))) {
      return res.status(400).json({ error: { message: "requestID and answers (or reject) required" } });
    }
    const directory = await resolveDirectory(dir);
    const action = reject ? "reject" : "reply";
    const r = await fetch(
      `${await serverUrl()}/question/${encodeURIComponent(requestID)}/${action}?directory=${encodeURIComponent(directory)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: reject ? "{}" : JSON.stringify({ answers }),
      },
    );
    if (!r.ok) throw new SCXError(r.status, (await r.text()) || `question ${action} failed`);
    res.json({ ok: true });
  } catch (e) {
    sendError(res, e);
  }
});

/** Abort the current agent turn. */
app.post("/api/agent/abort", async (req, res) => {
  try {
    const directory = await resolveDirectory(req.body?.directory);
    const client = await getClient(directory);
    await client.session.abort({ path: { id: req.body?.sessionID }, query: { directory } });
    res.json({ ok: true });
  } catch (e) {
    sendError(res, e);
  }
});

/**
 * Per-file changes the agent made in this session. OpenCode records them on
 * each user message (one entry per file per prompt, as a unified patch).
 */
app.get("/api/agent/diff", async (req, res) => {
  try {
    const directory = await resolveDirectory(req.query.directory);
    const client = await getClient(directory);
    const r = await client.session.messages({
      path: { id: String(req.query.sessionID) },
      query: { directory },
    });
    const messages = unwrap<any[]>(r) ?? [];
    const diff = messages
      .filter((m) => m?.info?.role === "user")
      .flatMap((m, turn) => (m.info.summary?.diffs ?? []).map((d: any) => ({ ...d, turn: turn + 1 })));
    res.json({ diff });
  } catch (e) {
    sendError(res, e);
  }
});

/** SSE stream of compact agent events for one session. */
app.get("/api/agent/events", async (req, res) => {
  const sessionID = String(req.query.sessionID || "");
  try {
    const directory = await resolveDirectory(req.query.directory);
    const client = await getClient(directory);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ kind: "open" })}\n\n`);

    const sub = await client.event.subscribe({ query: { directory } });
    let closed = false;
    req.on("close", () => { closed = true; sub.stream.return?.(undefined); });

    for await (const evt of sub.stream) {
      if (closed) break;
      // Filter to this session (events carry the id in different spots).
      const sid =
        (evt as any)?.properties?.part?.sessionID ??
        (evt as any)?.properties?.sessionID ??
        (evt as any)?.properties?.info?.sessionID;
      if (sessionID && sid && sid !== sessionID) continue;
      const ui = toUiEvent(evt);
      if (ui) res.write(`data: ${JSON.stringify(ui)}\n\n`);
    }
    res.end();
  } catch (e) {
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ kind: "error", message: String((e as Error)?.message ?? e) })}\n\n`);
      res.end();
    } else {
      sendError(res, e);
    }
  }
});

// Production (Docker): serve the built web app from the same origin.
const WEB_DIST = path.join(REPO_ROOT, "web", "dist");
if (process.env.NODE_ENV === "production" && fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST, { index: false }));
  app.get(/^(?!\/api\/|\/scx\/).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, "index.html")));
}

app.listen(PORT, process.env.HOST ?? "127.0.0.1", () => {
  console.log(`\n  Open Runner backend`);
  console.log(`  listening on http://${process.env.HOST ?? "127.0.0.1"}:${PORT}`);
  console.log(`  SCX upstream: ${BASE_URL}`);
  console.log(`  agent: ${REMOTE_URL ? `remote OpenCode at ${REMOTE_URL}` : "local OpenCode"}`);
  console.log(`  login: ${authRequired ? "password required" : "off (set OPEN_RUNNER_PASSWORD to enable)"}`);
  console.log(`  audit log: ${LOG_DIR || "off (set OPEN_RUNNER_LOG_DIR)"}`);
  console.log(`  default project: ${DEFAULT_DIRECTORY}\n`);
});
