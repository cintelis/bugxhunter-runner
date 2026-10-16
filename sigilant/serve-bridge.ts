// The bridge (bridge.ts) as a process: the runner's identity (identity.ts),
// and an MCP endpoint the agent's OpenCode is pointed at.
//
// | Variable | |
// |---|---|
// | the identity's, see identity.ts | |
// | `SIGILANT_WAIT_SECS` | how long a held call is waited for: 300 unless set |
// | `BRIDGE_PORT` | 8795 unless set |
// | `BRIDGE_TOKEN_FILE` | optional: a bearer the agent must present |

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { bridge } from "./bridge.ts";
import { env, sigilantClient } from "./identity.ts";
import { mcpHandler } from "./mcp.ts";

const log = (line: string) => console.log(`${new Date().toISOString()} [bridge] ${line}`);
const bridgeToken = process.env.BRIDGE_TOKEN_FILE?.trim() ? (await readFile(env("BRIDGE_TOKEN_FILE"), "utf8")).trim() : undefined;
const client = await sigilantClient({ name: "bugxhunter-bridge", version: "0.1.0" });

const handle = mcpHandler(bridge(client, { waitSecs: Number(env("SIGILANT_WAIT_SECS", "300")), log }), (auth) => !bridgeToken || auth === `Bearer ${bridgeToken}`, log);
const port = Number(env("BRIDGE_PORT", "8795"));
const server = createServer((req, res) => void handle(req, res));
await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
log(`listening on http://0.0.0.0:${port}/mcp as ${env("SIGILANT_AGENT", "bugxhunter-runner")} for ${env("SIGILANT_PRINCIPAL")} on ${env("SIGILANT_TASK")}, through ${env("SIGILANT_GATEWAY")}`);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
