// One MCP server over HTTP (Streamable HTTP, JSON replies), enough for a
// gateway or an agent to list tools and call them: `initialize`, the
// notifications, `ping`, `tools/list` and `tools/call`. Both halves of this
// package serve it: the tools behind the gateway (serve-tools.ts) and the
// bridge the agent talks to (serve-bridge.ts).

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const PROTOCOL_VERSION = "2025-06-18";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What a tool call comes to, as MCP has it. */
export interface McpResult {
  isError?: boolean;
  content: { type: "text"; text: string }[];
  structuredContent?: unknown;
}

export interface McpServer {
  name: string;
  version: string;
  tools(): Promise<McpTool[]>;
  call(name: string, args: Record<string, unknown>): Promise<McpResult>;
}

/** A result that is one JSON value, as text and as structured content. */
export const asResult = (value: unknown, isError = false): McpResult => ({
  isError,
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});

interface Message {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

/**
 * The request handler: `accept` says whether what the caller presented in
 * `Authorization` may use the server at all, and `log` hears each call.
 */
export function mcpHandler(
  server: McpServer,
  accept: (authorization: string | undefined) => boolean,
  log: (line: string) => void = () => {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
    };
    if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();
    if (!accept(req.headers.authorization)) {
      log("refused a caller without the credential");
      return json(401, { error: "unauthorized" });
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let message: Message;
    try {
      message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Message;
    } catch {
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    const reply = (result: unknown) => json(200, { jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        return json(
          200,
          {
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: server.name, version: server.version } },
          },
          { "mcp-session-id": randomBytes(12).toString("hex") },
        );
      case "ping":
        return reply({});
      case "tools/list":
        try {
          return reply({ tools: await server.tools() });
        } catch (why) {
          log(`tools/list failed: ${(why as Error).message}`);
          return json(200, { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32000, message: `the tools could not be listed: ${(why as Error).message}` } });
        }
      case "tools/call": {
        const name = String(message.params?.name ?? "");
        const args = message.params?.arguments ?? {};
        try {
          return reply(await server.call(name, args));
        } catch (why) {
          log(`${name} failed: ${(why as Error).message}`);
          return reply(asResult({ error: `${name} failed: ${(why as Error).message}` }, true));
        }
      }
      default:
        if (message.method?.startsWith("notifications/")) return void res.writeHead(202).end();
        return json(200, { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32601, message: "method not found" } });
    }
  };
}
