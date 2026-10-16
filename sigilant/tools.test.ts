import { strict as assert } from "node:assert";
import { test } from "node:test";

import { LIMITS, TOOLS, bxhTools } from "./tools.ts";

/** A GitHub that records what it was asked and answers from a table. */
function github(answers: Record<string, (init: RequestInit) => unknown>) {
  const asked: { url: string; method: string; accept: string; body?: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = init.headers as Record<string, string>;
    asked.push({ url, method: init.method ?? "GET", accept: headers.accept!, body: init.body as string | undefined });
    const route = url.replace("https://api.github.com", "");
    const answer = answers[`${init.method ?? "GET"} ${route}`] ?? answers[`${init.method ?? "GET"} ${route.split("?")[0]}`];
    if (!answer) return new Response("not found", { status: 404 });
    const value = answer(init);
    return typeof value === "string" ? new Response(value, { status: 200 }) : new Response(JSON.stringify(value), { status: 200 });
  };
  return { asked, fetch: fetchImpl };
}

const recorded: unknown[] = [];
const tools = (gh: ReturnType<typeof github>, target?: typeof fetch) =>
  bxhTools({
    github: { token: "ghp_test", fetch: gh.fetch },
    target: { fetch: target ?? (async () => new Response("")) },
    findings: {
      async record(f) {
        recorded.push(f);
        return "f-1";
      },
    },
  });

test("the tools are what the registry and the policy name", () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ["repo.read", "repo.comment", "repo.block", "target.request", "finding.record", "repo.scan", "net.discover", "discovery.report"]);
});

test("a file is read at the pull request's head, decoded, and cut to size", async () => {
  const gh = github({
    "GET /repos/cintelis/sigilant/pulls/42": () => ({ head: { sha: "abc123" } }),
    "GET /repos/cintelis/sigilant/contents/README.md": () => ({ type: "file", size: 5, content: Buffer.from("hello").toString("base64"), encoding: "base64" }),
  });
  const r = await tools(gh).call("repo.read", { repo: "cintelis/sigilant", pr: 42, path: "README.md" });
  assert.equal(r.isError, false);
  assert.deepEqual(r.structuredContent, { repo: "cintelis/sigilant", path: "README.md", ref: "abc123", size: 5, content: "hello", truncated: false });
  assert.match(gh.asked[1]!.url, /contents\/README\.md\?ref=abc123$/);
  const big = github({
    "GET /repos/cintelis/sigilant/contents/big.txt": () => ({ type: "file", size: 1, content: Buffer.from("x".repeat(LIMITS.file + 10)).toString("base64") }),
  });
  const cut = (await tools(big).call("repo.read", { repo: "cintelis/sigilant", path: "big.txt" })).structuredContent as { content: string; truncated: boolean };
  assert.equal(cut.content.length, LIMITS.file);
  assert.equal(cut.truncated, true);
});

test("a pull request is read with its diff", async () => {
  const gh = github({
    "GET /repos/cintelis/sigilant/pulls/42": (init) =>
      (init.headers as Record<string, string>).accept === "application/vnd.github.diff"
        ? "diff --git a/x b/x\n+1\n"
        : { title: "Add x", state: "open", base: { ref: "main" }, head: { ref: "x", sha: "abc" }, changed_files: 1, additions: 1, deletions: 0 },
  });
  const r = (await tools(gh).call("repo.read", { repo: "cintelis/sigilant", pr: 42 })).structuredContent as Record<string, unknown>;
  assert.equal(r.title, "Add x");
  assert.equal(r.head, "abc");
  assert.match(String(r.diff), /^diff --git/);
});

test("what is not a repository, and a read with nothing to read, are refused before GitHub is asked", async () => {
  const gh = github({});
  for (const args of [{ repo: "../etc", path: "x" }, { repo: "cintelis/sigilant" }, { repo: "cintelis/sigilant", path: "/etc/passwd" }]) {
    const r = await tools(gh).call("repo.read", args);
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.equal(gh.asked.length, 0);
});

test("without a token the repository tools say so", async () => {
  const t = bxhTools({ github: {}, target: {}, findings: { record: async () => "f" } });
  const r = await t.call("repo.read", { repo: "cintelis/sigilant", path: "README.md" });
  assert.equal(r.isError, true);
  assert.match((r.structuredContent as { error: string }).error, /no GitHub credential/);
});

test("a comment is posted, and a block is a review requesting changes", async () => {
  const gh = github({
    "POST /repos/cintelis/sigilant/issues/42/comments": () => ({ html_url: "https://github.com/c/s/pull/42#issuecomment-1" }),
    "POST /repos/cintelis/sigilant/pulls/42/reviews": () => ({ html_url: "https://github.com/c/s/pull/42#pullrequestreview-1" }),
  });
  const c = await tools(gh).call("repo.comment", { repo: "cintelis/sigilant", pr: 42, body: "Looks fine." });
  assert.deepEqual(c.structuredContent, { repo: "cintelis/sigilant", pr: 42, commented: true, url: "https://github.com/c/s/pull/42#issuecomment-1" });
  const b = await tools(gh).call("repo.block", { repo: "cintelis/sigilant", pr: 42, body: "Session token accepted after sign-out." });
  assert.equal((b.structuredContent as { blocked: boolean }).blocked, true);
  assert.deepEqual(JSON.parse(gh.asked[1]!.body!), { body: "Session token accepted after sign-out.", event: "REQUEST_CHANGES" });
  assert.equal((await tools(gh).call("repo.block", { repo: "cintelis/sigilant", pr: 42, body: " " })).isError, true, "no empty review");
});

test("a request to a target: the status, a few headers and the body, bounded", async () => {
  const seen: { url: string; method: string }[] = [];
  const target: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response("y".repeat(LIMITS.body + 1), { status: 404, headers: { "content-type": "text/plain", server: "demo", "x-other": "hidden" } });
  };
  const r = (await tools(github({}), target).call("target.request", { target: "erp:9443", method: "GET", path: "/health" })).structuredContent as Record<string, unknown>;
  assert.deepEqual(seen, [{ url: "https://erp:9443/health", method: "GET" }]);
  assert.equal(r.status, 404);
  assert.deepEqual(r.headers, { "content-type": "text/plain", server: "demo" });
  assert.equal(r.truncated, true);
  for (const args of [{ target: "erp:9443/x", method: "GET", path: "/" }, { target: "erp", method: "TRACE", path: "/" }, { target: "erp", method: "GET", path: "x" }]) {
    assert.equal((await tools(github({}), target).call("target.request", args)).isError, true, JSON.stringify(args));
  }
  assert.equal(seen.length, 1, "refused before any request");
  const down: typeof fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const failed = await tools(github({}), down).call("target.request", { target: "erp", method: "GET", path: "/" });
  assert.equal(failed.isError, true);
  assert.match((failed.structuredContent as { error: string }).error, /ECONNREFUSED/);
});

test("a scan names what looks like an agent, an MCP configuration or a key, and never the key", async () => {
  const b64 = (s: string) => ({ content: Buffer.from(s).toString("base64"), encoding: "base64" });
  const gh = github({
    "GET /repos/cintelis/sigilant": () => ({ default_branch: "main" }),
    "GET /repos/cintelis/sigilant/git/trees/main": () => ({
      tree: [
        { path: "package.json", type: "blob", size: 100 },
        { path: "apps/x/.mcp.json", type: "blob", size: 50 },
        { path: ".env.example", type: "blob", size: 80 },
        { path: "src/index.ts", type: "blob", size: 9000 },
        { path: "docs", type: "tree" },
      ],
    }),
    "GET /repos/cintelis/sigilant/contents/package.json": () => b64('{"dependencies":{"@modelcontextprotocol/sdk":"1.0.0","express":"5"}}'),
    "GET /repos/cintelis/sigilant/contents/apps/x/.mcp.json": () => b64('{"mcpServers":{}}'),
    "GET /repos/cintelis/sigilant/contents/.env.example": () => b64("ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n"),
  });
  const r = (await tools(gh).call("repo.scan", { repo: "cintelis/sigilant" })).structuredContent as {
    ref: string;
    files: number;
    read: number;
    candidates: { kind: string; path: string; matched: string[] }[];
  };
  assert.equal(r.ref, "main");
  assert.equal(r.files, 4);
  assert.equal(r.read, 3);
  assert.deepEqual(r.candidates, [
    { kind: "mcp_server", path: "apps/x/.mcp.json", matched: ["by name"] },
    { kind: "model_key", path: ".env.example", matched: ["by name"] },
    { kind: "agent", path: "package.json", matched: ["@modelcontextprotocol/sdk"] },
    { kind: "model_key", path: ".env.example", matched: ["a key shaped like anthropic's"] },
  ]);
  assert.doesNotMatch(JSON.stringify(r), /sk-ant-api03/, "the key itself is never handed back");
});

test("a target is asked whether it serves MCP, and what it says of itself", async () => {
  const seen: string[] = [];
  const target: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/mcp")) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "demo-erp", version: "1.0.0" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/oauth-protected-resource")) return new Response(JSON.stringify({ resource: "https://erp:9443", authorization_servers: ["https://idp"] }), { status: 200 });
    return new Response("not here", { status: 404 });
  };
  const r = (await tools(github({}), target).call("net.discover", { target: "erp:9443" })).structuredContent as {
    mcp: { answered: boolean; serverInfo: { name: string } };
    oauthProtectedResource: { body: { authorization_servers: string[] } };
    openid: { status: number };
  };
  assert.deepEqual(seen, ["POST https://erp:9443/mcp", "GET https://erp:9443/.well-known/oauth-protected-resource", "GET https://erp:9443/.well-known/openid-configuration"]);
  assert.equal(r.mcp.answered, true);
  assert.equal(r.mcp.serverInfo.name, "demo-erp");
  assert.deepEqual(r.oauthProtectedResource.body.authorization_servers, ["https://idp"]);
  assert.equal(r.openid.status, 404);
  assert.equal((await tools(github({}), target).call("net.discover", { target: "erp:9443/x" })).isError, true);
});

test("a report of a discovery is acknowledged, and nothing else: the gateway's record is the discovery", async () => {
  const r = await tools(github({})).call("discovery.report", { kind: "mcp_server", where: "erp:9443", name: "/mcp", evidence: "demo-erp" });
  assert.deepEqual(r.structuredContent, { reported: true, kind: "mcp_server", where: "erp:9443", name: "/mcp" });
  assert.equal((await tools(github({})).call("discovery.report", { kind: "thing", where: "x", name: "y" })).isError, true);
});

test("a finding is recorded at a known severity, and named", async () => {
  recorded.length = 0;
  const r = await tools(github({})).call("finding.record", { severity: "critical", title: "Session token accepted after sign-out" });
  assert.equal((r.structuredContent as { id: string }).id, "f-1");
  assert.equal(recorded.length, 1);
  assert.equal((await tools(github({})).call("finding.record", { severity: "urgent", title: "x" })).isError, true);
  assert.equal(recorded.length, 1);
});
