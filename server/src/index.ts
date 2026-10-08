/**
 * BugXHunter backend.
 *
 * A thin Express server in front of OpenCode (the coding agent) and the SCX
 * platform (the playground chat). The SCX API key stays server-side; the
 * browser only ever talks to this server. Streams are forwarded as
 * Server-Sent Events.
 */
import "./env.js"; // first: loads .env before the modules below read process.env
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { SCXError, type ChatParams } from "./scx.js";
import { PROVIDERS, PROXY_TOKEN, PORT, OPENROUTER_MODELS, apiKey, clients, clientFor, keySource, listModels } from "./providers.js";
import { KnowledgeBase, buildContextBlock } from "./rag.js";
import {
  getClient, serverUrl, resolveDirectory, projectFile, listAgentModels, toUiEvent, toUiMessages, parseModelId, oc, query, httpError,
  DEFAULT_DIRECTORY, DEFAULT_MODEL, REMOTE_URL, REPO_ROOT, ALLOWED_ROOTS,
} from "./opencode.js";
import type { PendingRequests, SessionSummary, SlashCommand, StoredMessage, Todo } from "../../shared/agent.js";
import { mountAuth, authRequired, issueSession } from "./auth.js";
import { audit, followOpencode, LOG_DIR } from "./audit.js";
import { saveAttachments, type Attachment } from "./attachments.js";
import * as vault from "./vault.js";
import * as github from "./github.js";

// Keys, the proxy token and the provider clients live in providers.ts, which
// also scrubs every secret from the environment before OpenCode is spawned.
const scx = clients.scx;
const kb = new KnowledgeBase(scx); // in-memory RAG store (POC scope)
const app = express();
app.disable("x-powered-by");

// Behind a reverse proxy, trust its X-Forwarded-* headers so req.ip is the
// real client (the login rate limit is per IP) and req.secure sees HTTPS.
// Express accepts a hop count ("1"), "loopback", a CIDR list, or true/false.
const TRUST_PROXY = process.env.TRUST_PROXY;
if (TRUST_PROXY) {
  app.set("trust proxy", /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY === "true" ? true : TRUST_PROXY);
}

/**
 * Key-injecting proxy for the agent, one route per provider (/scx/v1, and
 * /openrouter/v1). The agent's OpenCode talks to these with the proxy token,
 * and we forward chat/model calls upstream with the real key. So no provider
 * key ever enters the container (or, locally, the process) the agent's shell
 * runs in. Mounted before the JSON parser so request bodies pass through
 * untouched.
 */
const PROXY_PATHS = new Set(["/chat/completions", "/models"]);
for (const p of Object.values(PROVIDERS)) {
  const prefix = `/${p.id}/v1`;
  app.all(`${prefix}/*path`, async (req, res) => { // Express 5: a wildcard needs a name
    const sub = req.path.slice(prefix.length);
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${PROXY_TOKEN}`) return res.status(401).json({ error: { message: "bad proxy token" } });
    if (!PROXY_PATHS.has(sub)) return res.status(404).json({ error: { message: `not proxied: ${sub}` } });
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const ctrl = new AbortController();
      res.on("close", () => ctrl.abort());
      const upstream = await fetch(p.baseUrl + sub + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""), {
        method: req.method,
        headers: {
          Authorization: `Bearer ${apiKey(p.id)}`,
          ...(p.headers ?? {}),
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
      if (!res.headersSent) res.status((e as { status?: number }).status ?? 502).json({ error: { message: String((e as Error).message ?? e) } });
      else res.end();
    }
  });
}

/**
 * DNS-rebinding guard. A malicious page can point a hostname it controls at
 * 127.0.0.1 and then call this API from the victim's browser; the Host header
 * still names the attacker's domain, so refuse anything but our own names.
 * Add the names a reverse proxy serves under via ALLOWED_HOSTS.
 */
const ALLOWED_HOSTS = new Set([
  "localhost", "127.0.0.1", "[::1]",
  ...(process.env.ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
]);
app.use("/api", (req, res, next) => {
  const host = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
  if (ALLOWED_HOSTS.has(host)) return next();
  res.status(403).json({ error: { message: `Host "${host}" is not allowed. Add it to ALLOWED_HOSTS.` } });
});

// Prompts can carry attachments (base64), so allow larger bodies there.
app.use("/api/agent/prompt", express.json({ limit: "40mb" }));
app.use(express.json({ limit: "4mb" }));
mountAuth(app, ALLOWED_HOSTS);
// Any authenticated write counts as activity for the vault's auto-lock (reads
// don't, so the sidebar's status polling can't keep it open).
app.use("/api", (req, _res, next) => {
  if (req.method !== "GET") vault.touch();
  next();
});

const sendError = (res: express.Response, e: unknown) => {
  if (e instanceof SCXError) {
    // The provider rejecting our key is a configuration problem here, not the
    // browser's session: report it as an upstream failure with a pointer.
    if (e.status === 401 || e.status === 403) {
      return res.status(502).json({ error: { message: `SCX rejected the API key (${e.status}: ${e.message}). Check the SCX_API key in the vault.`, type: e.type } });
    }
    return res.status(e.status).json({ error: { message: e.message, type: e.type } });
  }
  const status = (e as { status?: number })?.status;
  if (status) return res.status(status).json({ error: { message: (e as Error).message } });
  console.error("[server error]", e);
  return res.status(500).json({ error: { message: String((e as Error)?.message ?? e) } });
};

app.get("/api/health", (_req, res) => res.json({ ok: true, baseUrl: PROVIDERS.scx.baseUrl }));

// --- Key vault (see shared/vault.d.ts) --------------------------------------
// The browser does the key derivation and wrapping; these routes only store
// ciphertext, accept an unseal key into memory, and manage sealed items.

app.get("/api/vault", (_req, res) => res.json(vault.status(keySource("scx"))));

app.post("/api/vault/init", (req, res) => {
  try {
    const { doc, dek } = req.body ?? {};
    if (!doc || typeof dek !== "string") return res.status(400).json({ error: { message: "doc and dek required" } });
    vault.initialise(doc, dek);
    // Creating the vault turns sign-in on; the browser that created it is signed in.
    issueSession(req, res);
    res.json(vault.status(keySource("scx")));
  } catch (e) {
    sendError(res, e);
  }
});

app.post("/api/vault/unseal", (req, res) => {
  try {
    if (typeof req.body?.dek !== "string") return res.status(400).json({ error: { message: "dek required" } });
    vault.unseal(req.body?.dek);
    res.json(vault.status(keySource("scx")));
  } catch (e) {
    sendError(res, e);
  }
});

app.post("/api/vault/seal", (_req, res) => {
  vault.sealVault();
  res.json(vault.status(keySource("scx")));
});

app.put("/api/vault/items/:name", (req, res) => {
  try {
    if (typeof req.body?.value !== "string") return res.status(400).json({ error: { message: "value required" } });
    vault.setItem(req.params.name, req.body?.value);
    res.json(vault.status(keySource("scx")));
  } catch (e) {
    sendError(res, e);
  }
});

app.delete("/api/vault/items/:name", (req, res) => {
  try {
    vault.deleteItem(req.params.name);
    res.json(vault.status(keySource("scx")));
  } catch (e) {
    sendError(res, e);
  }
});

/** Enrol another passkey. The browser must prove it holds the current key (it wrapped it for the new method). */
app.post("/api/vault/methods", (req, res) => {
  try {
    const { method, dek } = req.body ?? {};
    if (!method || typeof dek !== "string") return res.status(400).json({ error: { message: "method and dek required" } });
    vault.addMethod(method, dek);
    res.json(vault.status(keySource("scx")));
  } catch (e) {
    sendError(res, e);
  }
});

app.delete("/api/vault/methods/:id", (req, res) => {
  try {
    vault.removeMethod(req.params.id);
    res.json(vault.status(keySource("scx")));
  } catch (e) {
    sendError(res, e);
  }
});

/**
 * Delete the vault, to recreate it with new factors. Needs the current key as
 * proof, so it is a rotation tool for the owner, not a way around the lock.
 * Lost every factor? Reset from the server instead: `npm run vault:reset`.
 */
app.delete("/api/vault", (req, res) => {
  try {
    if (typeof req.body?.dek !== "string") return res.status(400).json({ error: { message: "dek required" } });
    vault.destroy(req.body?.dek);
    res.json(vault.status(keySource("scx")));
  } catch (e) {
    sendError(res, e);
  }
});

/** List models (with capabilities + pricing) for the playground's model picker. */
// --- GitHub, read-only (see shared/github.d.ts) ------------------------------
app.get("/api/github", async (_req, res) => {
  try { res.json(await github.status()); } catch (e) { sendError(res, e); }
});
app.post("/api/github/connect/start", async (_req, res) => {
  try { res.json(await github.connectStart()); } catch (e) { sendError(res, e); }
});
app.post("/api/github/connect/poll", async (req, res) => {
  try {
    const r = await github.connectPoll(req.body?.id);
    if (r.status === "connected") audit("github.connected", { login: r.login, storage: r.storage });
    res.json(r);
  } catch (e) { sendError(res, e); }
});
app.delete("/api/github/connect", (_req, res) => {
  try { github.disconnect(); audit("github.disconnected"); res.json({ ok: true }); } catch (e) { sendError(res, e); }
});
app.get("/api/github/repos", async (_req, res) => {
  try { res.json({ repos: await github.listRepos() }); } catch (e) { sendError(res, e); }
});
app.get("/api/github/branches", async (req, res) => {
  try { res.json({ branches: await github.listBranches(req.query.repo) }); } catch (e) { sendError(res, e); }
});
/** Clone into the workspace, or fast-forward the clone already there. Slow: a big repository takes a while. */
app.post("/api/github/clone", async (req, res) => {
  try {
    const result = await github.cloneOrUpdate({ repo: req.body?.repo, branch: req.body?.branch });
    audit("github.clone", { repo: req.body?.repo, ...result });
    res.json(result);
  } catch (e) {
    audit("github.clone.failed", { repo: req.body?.repo, error: String((e as Error).message ?? e) });
    sendError(res, e);
  }
});

app.get("/api/models", async (_req, res) => {
  try {
    res.json({ data: await listModels() });
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
    const { client, model } = clientFor(String(params.model ?? ""));
    const call = { ...params, model };
    if (params.stream) {
      const upstream = await client.chatStreamResponse(call);
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
      const completion = await client.chat(call);
      res.json(retrieved.length
        ? { ...completion, scx_sources: retrieved.map((r) => ({ doc: r.doc, score: Number(r.score.toFixed(3)) })) }
        : completion);
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
  if (r?.error) throw httpError(400, typeof r.error === "string" ? r.error : JSON.stringify(r.error));
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

/**
 * Download a file the agent wrote (the UI links paths it prints). The file
 * must be inside the project folder; see projectFile.
 */
app.get("/api/agent/file", async (req, res) => {
  try {
    const directory = await resolveDirectory(req.query.directory);
    const file = projectFile(directory, req.query.path);
    audit("file.download", { directory, file });
    res.download(file, path.basename(file));
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
    const raw = await oc<any[]>(`/session${query({ directory, roots: true, limit: 100 })}`);
    const sessions: SessionSummary[] = raw
      .filter((s) => !s.parentID && s.directory === directory)
      .map((s) => ({
        id: s.id, title: s.title, created: s.time?.created, updated: s.time?.updated ?? s.time?.created,
        files: s.summary?.files ?? 0, additions: s.summary?.additions ?? 0, deletions: s.summary?.deletions ?? 0,
      }))
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    res.json({ sessions });
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
    const todos = await oc<Todo[]>(`/session/${encodeURIComponent(req.params.id)}/todo${query({ directory })}`).catch(() => []);
    const messages: StoredMessage[] = toUiMessages(msgs ?? []);
    res.json({ messages, todos });
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
    const list = await oc<any[]>(`/command${query({ directory })}`).catch(() => []);
    const commands: SlashCommand[] = list
      .filter((c) => c.source !== "skill")
      .map((c) => ({ name: c.name, description: c.description ?? "", hint: (c.hints ?? []).includes("$ARGUMENTS") ? "[arguments]" : "" }));
    res.json({ commands });
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
    oc(`/session/${encodeURIComponent(sessionID)}/command${query({ directory })}`, {
      method: "POST",
      json: { command, arguments: args, agent, model: model ?? DEFAULT_MODEL },
    }).catch((e) => audit("error", { directory, session: sessionID, command, error: String((e as Error).message ?? e) }));
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
    oc(`/session/${encodeURIComponent(sessionID)}/summarize${query({ directory })}`, {
      method: "POST",
      json: { providerID: m.providerID, modelID: m.modelID },
    }).catch((e) => audit("error", { directory, session: sessionID, command: "compact", error: String((e as Error).message ?? e) }));
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

    const permsRaw = await oc<any[]>(`/permission${query({ directory })}`).catch(() => []);
    // GET /question lists every pending question request (same shape as the
    // question.asked event); filter to this session like the permissions.
    const qRaw = await oc<any[]>(`/question${query({ directory })}`).catch(() => []);

    const pending: PendingRequests = {
      permissions: permsRaw
        .filter((p) => !sessionID || p.sessionID === sessionID)
        .map((p) => ({
          kind: "permission",
          sessionID: p.sessionID,
          permissionID: p.id,
          permType: p.permission ?? p.type,
          title: p.metadata?.command ?? p.title,
          pattern: p.patterns ?? p.pattern,
          callID: p.callID,
        })),
      questions: qRaw
        .filter((q) => !sessionID || q.sessionID === sessionID)
        .map((q) => ({
          kind: "question",
          sessionID: q.sessionID,
          requestID: q.id,
          questions: q.questions ?? [],
          callID: q.tool?.callID,
        })),
    };
    res.json(pending);
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

// Audit log of agent activity (see audit.ts), fed by OpenCode's event stream.
if (LOG_DIR) serverUrl().then(followOpencode).catch((e) => console.error("[audit] not following OpenCode:", e));

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
    await oc(`/question/${encodeURIComponent(requestID)}/${action}${query({ directory })}`, {
      method: "POST",
      json: reject ? {} : { answers },
    });
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
    // Comment lines keep proxies (Vite, a TLS reverse proxy) from cutting an
    // idle stream during a long tool call.
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);

    const sub = await client.event.subscribe({ query: { directory } });
    let closed = false;
    req.on("close", () => { closed = true; clearInterval(keepAlive); sub.stream.return?.(undefined); });

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
    clearInterval(keepAlive);
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

// Body-parser failures (oversized attachment payloads, malformed JSON) and
// anything a route threw synchronously: answer in JSON like every other error.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = Number(err?.status ?? err?.statusCode ?? 500);
  const message = err?.type === "entity.too.large"
    ? "Request too large: attachments are limited to 25 MB each and about 30 MB per message."
    : err?.type === "entity.parse.failed" ? "Malformed JSON body." : String(err?.message ?? err);
  if (status >= 500) console.error("[server error]", err);
  res.status(status).json({ error: { message } });
});

const server = app.listen(PORT, process.env.HOST ?? "127.0.0.1", () => {
  console.log(`\n  BugXHunter backend`);
  console.log(`  listening on http://${process.env.HOST ?? "127.0.0.1"}:${PORT}`);
  for (const p of Object.values(PROVIDERS)) {
    const src = keySource(p.id);
    const where = {
      vault: "vault",
      env: ".env — consider moving it into the vault",
      "opencode-auth": "OpenCode's auth.json — consider moving it into the vault",
      none: p.id === "scx" ? "none yet — set up the vault in the sidebar" : "not configured (optional)",
    }[src];
    console.log(`  ${p.name} key: ${where}`);
  }
  if (vault.isInitialised()) console.log(`  vault: ${vault.VAULT_FILE} (${vault.isUnsealed() ? "unsealed" : "sealed — unlock it in the UI"})`);
  if (OPENROUTER_MODELS.length) console.log(`  OpenRouter models for the agent: ${OPENROUTER_MODELS.join(", ")}`);
  console.log(`  agent: ${REMOTE_URL ? `remote OpenCode at ${REMOTE_URL}` : "local OpenCode"}`);
  if (!REMOTE_URL) console.log(`  project roots: ${ALLOWED_ROOTS.length ? ALLOWED_ROOTS.join(", ") : "any folder (set OPEN_RUNNER_ALLOWED_ROOTS to restrict)"}`);
  console.log(`  sign-in: ${authRequired() ? "passkey (the vault's)" : "open — set up the vault in the sidebar to require a passkey"}`);
  if (TRUST_PROXY) console.log(`  trust proxy: ${TRUST_PROXY}`);
  console.log(`  audit log: ${LOG_DIR || "off (set OPEN_RUNNER_LOG_DIR)"}`);
  console.log(`  default project: ${DEFAULT_DIRECTORY}\n`);
});
server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE"
    ? `\n[fatal] Port ${PORT} is already in use (another backend running?). Set PORT to use a different one.\n`
    : `\n[fatal] Could not listen on port ${PORT}: ${e.message}\n`);
  process.exit(1);
});
