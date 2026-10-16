// The runner's tools, behind a Sigilant gateway: what the gateway forwards to
// once policy has allowed a call. Each names what it is about — the
// repository, the target, the finding — so that policy can hold it to the
// engagement's signed scope; the gateway has decided before anything here
// runs, and the scope is never checked again here.
//
// | Tool | Does |
// |---|---|
// | `repo.read` | a file of a repository at a ref, or a pull request and its diff |
// | `repo.comment` | a comment on a pull request |
// | `repo.block` | a review requesting changes, which blocks the merge |
// | `target.request` | one HTTP request to a target, by method and path |
// | `finding.record` | a finding, at a severity, into the findings file |
// | `repo.scan` | what a repository holds that looks like an agent, an MCP configuration or a model key: candidates, by path |
// | `net.discover` | whether a target serves MCP, and what it says of itself |
// | `discovery.report` | a discovery, as the gateway records it: the record is the evidence; this only acknowledges |
// | `run.usage` | one step of a run: its tokens, cost and time, as the runner's own process reports it; this only acknowledges |
//
// GitHub is reached with a token of the engagement's (a fine-grained token
// with Contents: read and Pull requests: write on the repositories in scope),
// not the UI's device-flow sign-in: a run started by a webhook has nobody at
// the keyboard to unseal a vault.

import { type McpResult, type McpTool, asResult } from "./mcp.ts";

const string = (description: string) => ({ type: "string", description });

export const TOOLS: McpTool[] = [
  {
    name: "repo.read",
    description:
      "Read from a repository in the engagement's scope: a file (path, at the pull request's head if pr is given, else the default branch), or a pull request and its diff (pr without path).",
    inputSchema: {
      type: "object",
      properties: { repo: string("owner/name"), pr: { type: "integer", description: "a pull request number" }, path: string("a file path in the repository") },
      required: ["repo"],
    },
  },
  {
    name: "repo.comment",
    description: "Comment on a pull request of a repository in the engagement's scope.",
    inputSchema: {
      type: "object",
      properties: { repo: string("owner/name"), pr: { type: "integer", description: "the pull request number" }, body: string("the comment, Markdown") },
      required: ["repo", "pr", "body"],
    },
  },
  {
    name: "repo.block",
    description: "Request changes on a pull request, which blocks its merge. A certified tester confirms this before it takes effect.",
    inputSchema: {
      type: "object",
      properties: { repo: string("owner/name"), pr: { type: "integer", description: "the pull request number" }, body: string("why, Markdown") },
      required: ["repo", "pr", "body"],
    },
  },
  {
    name: "target.request",
    description:
      "One HTTP request to a target in the engagement's scope. Reads (GET, HEAD, OPTIONS) go through; anything that could change the target waits for the engagement's principal.",
    inputSchema: {
      type: "object",
      properties: {
        target: string("host, or host:port, as the scope names it"),
        method: { type: "string", enum: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] },
        path: string("the path, starting with /"),
      },
      required: ["target", "method", "path"],
    },
  },
  {
    name: "finding.record",
    description: "Record a finding. A critical one is confirmed by a certified tester before it stands.",
    inputSchema: {
      type: "object",
      properties: { severity: { type: "string", enum: ["low", "medium", "high", "critical"] }, title: string("one line") },
      required: ["severity", "title"],
    },
  },
  {
    name: "repo.scan",
    description:
      "Look through a repository in the engagement's scope for what looks like an agent, an MCP server configuration or a model API key: candidates by path, with what matched. Keys are never shown, only where one seems to be.",
    inputSchema: {
      type: "object",
      properties: { repo: string("owner/name"), pr: { type: "integer", description: "a pull request, to look at its head" } },
      required: ["repo"],
    },
  },
  {
    name: "net.discover",
    description: "Ask a target in the engagement's scope whether it serves MCP, and what it says of itself: its MCP endpoint, its OAuth protected-resource and OpenID metadata.",
    inputSchema: { type: "object", properties: { target: string("host, or host:port, as the scope names it") }, required: ["target"] },
  },
  {
    name: "discovery.report",
    description:
      "Report one thing found: what kind (mcp_server, agent, model_key, tool), where (the repository or the target, exactly as the scope names it), what it is called there (a path, an endpoint), and brief evidence. The gateway's record of this call is the discovery.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["mcp_server", "agent", "model_key", "tool"] },
        where: string("the repository (owner/name) or the target (host:port), as the scope names it"),
        name: string("a path in the repository, or an endpoint at the target"),
        evidence: string("one line of what was seen; never a secret"),
      },
      required: ["kind", "where", "name"],
    },
  },
  {
    name: "run.usage",
    description:
      "One step of a run — a turn of the model — with what it cost in tokens and money and when it ran. Reported by the runner's own process after each step; the gateway's record of this call is the usage.",
    inputSchema: {
      type: "object",
      properties: {
        run: string("the session"),
        step: string("the message"),
        model: string("provider/model"),
        input: { type: "integer" },
        output: { type: "integer" },
        reasoning: { type: "integer" },
        cache_read: { type: "integer" },
        cache_write: { type: "integer" },
        cost_micros: { type: "integer", description: "millionths of a dollar" },
        started_ms: { type: "integer" },
        completed_ms: { type: "integer" },
        tool_calls: { type: "integer" },
      },
      required: ["run", "step", "input", "output", "reasoning", "cache_read", "cache_write", "cost_micros", "started_ms", "completed_ms", "tool_calls"],
    },
  },
];

/** Paths that are MCP or agent configuration, by name. */
const CONFIG_FILES = [
  /(^|\/)\.?mcp\.json$/,
  /(^|\/)claude_desktop_config\.json$/,
  /(^|\/)\.cursor\/mcp\.json$/,
  /(^|\/)\.vscode\/mcp\.json$/,
  /(^|\/)opencode\.json$/,
  /(^|\/)\.opencode\/.*\.json$/,
  /(^|\/)\.env(\..*)?$/,
];
/** Manifests that name an agent framework when they depend on one. */
const MANIFESTS = [/(^|\/)package\.json$/, /(^|\/)requirements\.txt$/, /(^|\/)pyproject\.toml$/];
const FRAMEWORKS = [
  "@modelcontextprotocol/sdk",
  "@anthropic-ai/sdk",
  "@langchain/",
  "langchain",
  "langgraph",
  "crewai",
  "autogen",
  "openai",
  "anthropic",
  "@sigilant/sdk",
  "opencode-ai",
  '"mcp"',
  "mcp[",
  "fastmcp",
];
/** What a model provider's key looks like; the match is never handed back, only its shape. */
const KEY_SHAPES: [string, RegExp][] = [
  ["anthropic", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai", /sk-(proj-)?(?!ant-)[A-Za-z0-9_-]{20,}/],
  ["google", /AIza[0-9A-Za-z_-]{35}/],
  ["huggingface", /hf_[A-Za-z0-9]{20,}/],
];
/** How many files a scan reads in full. */
export const SCAN_LIMIT = 40;

export interface Finding {
  at: string;
  severity: string;
  title: string;
}

export interface ToolsOptions {
  github: {
    /** The engagement's token; without one the repository tools refuse. */
    token?: string;
    apiBase?: string;
    fetch?: typeof fetch;
  };
  target: {
    fetch?: typeof fetch;
    /** `https` unless the targets are plain HTTP, as a lab's may be. */
    scheme?: "https" | "http";
    timeoutMs?: number;
  };
  findings: {
    /** Keeps the finding, and says what it is now called. */
    record(finding: Finding): Promise<string>;
  };
}

const REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,100})$/;
const TARGET = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?(?::\d{1,5})?$/;
const METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);

/** How much of a file, a diff or a response is handed back. */
export const LIMITS = { file: 64 * 1024, diff: 200 * 1024, body: 32 * 1024 };

const bounded = (text: string, limit: number) => (text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false });

/** The tools, as one MCP server's worth. */
export function bxhTools(options: ToolsOptions): { tools: McpTool[]; call(name: string, args: Record<string, unknown>): Promise<McpResult> } {
  const api = options.github.apiBase ?? "https://api.github.com";
  const ghFetch = options.github.fetch ?? fetch;
  const tFetch = options.target.fetch ?? fetch;
  const refuse = (why: string) => asResult({ error: why }, true);

  const repoOf = (v: unknown) => {
    const s = typeof v === "string" ? v.trim().replace(/\.git$/i, "") : "";
    return REPO.test(s) ? s : undefined;
  };
  const prOf = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : undefined);

  const github = async (route: string, init: RequestInit & { accept?: string } = {}) => {
    if (!options.github.token) throw new Error("no GitHub credential: the engagement's token is not configured (GITHUB_TOKEN_FILE)");
    const response = await ghFetch(`${api}${route}`, {
      ...init,
      headers: {
        authorization: `Bearer ${options.github.token}`,
        accept: init.accept ?? "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "bugxhunter-sigilant",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} for ${route}`);
    return response;
  };

  return {
    tools: TOOLS,
    async call(name, args) {
      try {
        return await run(name, args);
      } catch (why) {
        // GitHub refusing, a token missing, a target unreachable: an error the model reads, not a dead call.
        return refuse(`${name}: ${(why as Error).message}`);
      }
    },
  };

  async function run(name: string, args: Record<string, unknown>): Promise<McpResult> {
    switch (name) {
      case "repo.read": {
        const repo = repoOf(args.repo);
        if (!repo) return refuse("repo must be owner/name");
        const pr = prOf(args.pr);
        const path = typeof args.path === "string" && args.path && !args.path.startsWith("/") ? args.path : undefined;
        if (!path && !pr) return refuse("give a path to read, or a pr to read the diff of");
        if (path) {
          let ref: string | undefined;
          if (pr) ref = ((await (await github(`/repos/${repo}/pulls/${pr}`)).json()) as { head: { sha: string } }).head.sha;
          const file = (await (await github(`/repos/${repo}/contents/${path}${ref ? `?ref=${ref}` : ""}`)).json()) as {
            type: string;
            size: number;
            content?: string;
            encoding?: string;
          };
          if (file.type !== "file") return refuse(`${path} is a ${file.type}, not a file`);
          const text = Buffer.from(file.content ?? "", (file.encoding ?? "base64") as BufferEncoding).toString("utf8");
          const { text: content, truncated } = bounded(text, LIMITS.file);
          return asResult({ repo, path, ref: ref ?? "default", size: file.size, content, truncated });
        }
        const pull = (await (await github(`/repos/${repo}/pulls/${pr}`)).json()) as {
          title: string;
          state: string;
          base: { ref: string };
          head: { ref: string; sha: string };
          changed_files: number;
          additions: number;
          deletions: number;
        };
        const diff = await (await github(`/repos/${repo}/pulls/${pr}`, { accept: "application/vnd.github.diff" })).text();
        const { text, truncated } = bounded(diff, LIMITS.diff);
        return asResult({
          repo,
          pr,
          title: pull.title,
          state: pull.state,
          base: pull.base.ref,
          head: pull.head.sha,
          changedFiles: pull.changed_files,
          additions: pull.additions,
          deletions: pull.deletions,
          diff: text,
          truncated,
        });
      }
      case "repo.comment":
      case "repo.block": {
        const repo = repoOf(args.repo);
        const pr = prOf(args.pr);
        const body = typeof args.body === "string" ? args.body.trim() : "";
        if (!repo || !pr || !body) return refuse("repo (owner/name), pr and body are required");
        if (name === "repo.comment") {
          const made = (await (await github(`/repos/${repo}/issues/${pr}/comments`, { method: "POST", body: JSON.stringify({ body }) })).json()) as { html_url: string };
          return asResult({ repo, pr, commented: true, url: made.html_url });
        }
        const review = (await (
          await github(`/repos/${repo}/pulls/${pr}/reviews`, { method: "POST", body: JSON.stringify({ body, event: "REQUEST_CHANGES" }) })
        ).json()) as { html_url: string };
        return asResult({ repo, pr, blocked: true, url: review.html_url });
      }
      case "target.request": {
        const target = typeof args.target === "string" && TARGET.test(args.target) ? args.target : undefined;
        const method = typeof args.method === "string" && METHODS.has(args.method) ? args.method : undefined;
        const path = typeof args.path === "string" && args.path.startsWith("/") ? args.path : undefined;
        if (!target || !method || !path) return refuse("target (host or host:port), a method and a path starting with / are required");
        const url = `${options.target.scheme ?? "https"}://${target}${path}`;
        try {
          const response = await tFetch(url, { method, redirect: "manual", signal: AbortSignal.timeout(options.target.timeoutMs ?? 10_000) });
          const { text, truncated } = bounded(await response.text(), LIMITS.body);
          const headers: Record<string, string> = {};
          for (const h of ["content-type", "server", "location", "www-authenticate"]) {
            const v = response.headers.get(h);
            if (v) headers[h] = v;
          }
          return asResult({ target, method, path, status: response.status, headers, body: text, truncated });
        } catch (why) {
          return refuse(`${method} ${url}: ${(why as Error).message}`);
        }
      }
      case "repo.scan": {
        const repo = repoOf(args.repo);
        if (!repo) return refuse("repo must be owner/name");
        const pr = prOf(args.pr);
        let ref: string;
        if (pr) ref = ((await (await github(`/repos/${repo}/pulls/${pr}`)).json()) as { head: { sha: string } }).head.sha;
        else ref = ((await (await github(`/repos/${repo}`)).json()) as { default_branch: string }).default_branch;
        const tree = (await (await github(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`)).json()) as {
          tree: { path: string; type: string; size?: number }[];
          truncated?: boolean;
        };
        const files = tree.tree.filter((e) => e.type === "blob");
        const candidates: { kind: string; path: string; matched: string[] }[] = [];
        // Configuration by name; every .env file committed is a candidate as it stands.
        for (const f of files) {
          if (CONFIG_FILES.some((re) => re.test(f.path))) {
            candidates.push({ kind: /\.env/.test(f.path) ? "model_key" : "mcp_server", path: f.path, matched: ["by name"] });
          }
        }
        // Manifests and configuration, read, for frameworks and for keys.
        const toRead = files
          .filter((f) => (MANIFESTS.some((re) => re.test(f.path)) || CONFIG_FILES.some((re) => re.test(f.path))) && (f.size ?? 0) <= LIMITS.file)
          .slice(0, SCAN_LIMIT);
        let read = 0;
        for (const f of toRead) {
          const file = (await (await github(`/repos/${repo}/contents/${f.path}?ref=${encodeURIComponent(ref)}`)).json()) as { content?: string; encoding?: string };
          const content = Buffer.from(file.content ?? "", (file.encoding ?? "base64") as BufferEncoding).toString("utf8");
          read++;
          const frameworks = FRAMEWORKS.filter((name) => content.includes(name));
          if (frameworks.length && MANIFESTS.some((re) => re.test(f.path))) candidates.push({ kind: "agent", path: f.path, matched: frameworks });
          const keys = KEY_SHAPES.filter(([, re]) => re.test(content)).map(([who]) => `a key shaped like ${who}'s`);
          if (keys.length) candidates.push({ kind: "model_key", path: f.path, matched: keys });
        }
        return asResult({ repo, ref, files: files.length, read, truncated: tree.truncated === true, candidates });
      }
      case "net.discover": {
        const target = typeof args.target === "string" && TARGET.test(args.target) ? args.target : undefined;
        if (!target) return refuse("target (host or host:port) is required");
        const base = `${options.target.scheme ?? "https"}://${target}`;
        const ask = async (path: string, init: RequestInit = {}) => {
          try {
            const r = await tFetch(`${base}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(options.target.timeoutMs ?? 10_000) });
            const text = (await r.text()).slice(0, LIMITS.body);
            let body: unknown = text;
            try {
              body = JSON.parse(text);
            } catch {
              // Not JSON: kept as text.
            }
            return { status: r.status, contentType: r.headers.get("content-type") ?? undefined, body };
          } catch (why) {
            return { error: (why as Error).message };
          }
        };
        const initialize = {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bugxhunter-discovery", version: "0.1.0" } },
        };
        const mcp = await ask("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(initialize) });
        const server = (mcp as { body?: { result?: { serverInfo?: unknown; protocolVersion?: unknown } } }).body?.result;
        return asResult({
          target,
          mcp: { ...mcp, body: undefined, answered: server?.serverInfo !== undefined, serverInfo: server?.serverInfo, protocolVersion: server?.protocolVersion },
          oauthProtectedResource: await ask("/.well-known/oauth-protected-resource"),
          openid: await ask("/.well-known/openid-configuration"),
        });
      }
      case "discovery.report": {
        const kind = typeof args.kind === "string" && ["mcp_server", "agent", "model_key", "tool"].includes(args.kind) ? args.kind : undefined;
        const where = typeof args.where === "string" ? args.where.trim() : "";
        const what = typeof args.name === "string" ? args.name.trim() : "";
        if (!kind || !where || !what) return refuse("kind, where and name are required");
        // Nothing to do: the gateway's record of this call is the discovery, and the sync service folds it from the chain.
        return asResult({ reported: true, kind, where, name: what });
      }
      case "run.usage": {
        const run = typeof args.run === "string" ? args.run.trim() : "";
        const step = typeof args.step === "string" ? args.step.trim() : "";
        if (!run || !step) return refuse("run and step are required");
        // Nothing to do: the gateway's record of this call is the usage, and the sync service folds the steps into runs.
        return asResult({ recorded: true, run, step });
      }
      case "finding.record": {
        const severity = typeof args.severity === "string" && SEVERITIES.has(args.severity) ? args.severity : undefined;
        const title = typeof args.title === "string" ? args.title.trim().slice(0, 200) : "";
        if (!severity || !title) return refuse("severity (low, medium, high or critical) and a title are required");
        const finding = { at: new Date().toISOString(), severity, title };
        const id = await options.findings.record(finding);
        return asResult({ recorded: true, id, ...finding });
      }
      default:
        return refuse(`no tool ${name}`);
    }
  }
}
