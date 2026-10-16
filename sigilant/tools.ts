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
];

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
