import { strict as assert } from "node:assert";
import { type Server, createServer } from "node:http";
import { after, before, test } from "node:test";

import { type McpServer, asResult, mcpHandler } from "./mcp.ts";

const served: McpServer = {
  name: "test",
  version: "0",
  tools: async () => [{ name: "echo", description: "says it back", inputSchema: { type: "object" } }],
  call: async (name, args) => {
    if (name === "boom") throw new Error("no");
    return asResult({ name, args });
  },
};

let server: Server;
let at: string;
before(async () => {
  server = createServer((req, res) => void mcpHandler(served, (auth) => auth === "Bearer right")(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  at = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
});
after(() => server.close());

const post = (body: unknown, auth = "Bearer right") =>
  fetch(at, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body) });

test("the handshake, the tools and a call", async () => {
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(init.status, 200);
  assert.ok(init.headers.get("mcp-session-id"));
  assert.equal(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name, "test");
  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const list = (await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as { result: { tools: { name: string }[] } };
  assert.deepEqual(list.result.tools.map((t) => t.name), ["echo"]);
  const call = (await (await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { a: 1 } } })).json()) as {
    result: { isError: boolean; structuredContent: unknown };
  };
  assert.equal(call.result.isError, false);
  assert.deepEqual(call.result.structuredContent, { name: "echo", args: { a: 1 } });
});

test("a tool that throws is an error result, not a dead connection", async () => {
  const call = (await (await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "boom", arguments: {} } })).json()) as {
    result: { isError: boolean; content: { text: string }[] };
  };
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0]!.text, /boom failed: no/);
});

test("without the credential, nothing; an unknown method is said to be one", async () => {
  assert.equal((await post({ jsonrpc: "2.0", id: 5, method: "tools/list" }, "Bearer wrong")).status, 401);
  assert.equal((await fetch(at)).status, 405);
  const unknown = (await (await post({ jsonrpc: "2.0", id: 6, method: "resources/list" })).json()) as { error: { code: number } };
  assert.equal(unknown.error.code, -32601);
  const bad = await fetch(at, { method: "POST", headers: { authorization: "Bearer right" }, body: "{" });
  assert.equal(bad.status, 400);
});
