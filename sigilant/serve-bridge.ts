// The bridge (bridge.ts) as a process: the runner's identity, and an MCP
// endpoint the agent's OpenCode is pointed at. It proves what the runner is
// the way a production workload does — a client-credentials token from the
// workload IdP, which the issuer checks against the registry before minting a
// task token — and calls the gateway over the platform's post-quantum TLS.
//
// | Variable | |
// |---|---|
// | `SIGILANT_ISSUER` | the issuer, for task tokens |
// | `SIGILANT_GATEWAY` | the gateway's MCP endpoint |
// | `SIGILANT_WORKLOAD_TOKEN_URL` | the workload IdP's token endpoint |
// | `SIGILANT_CLIENT_ID`, `SIGILANT_CLIENT_SECRET_FILE` | the runner's workload identity |
// | `SIGILANT_AGENT` | its registry id |
// | `SIGILANT_PRINCIPAL` | who the engagement is run for, e.g. `user:nick@cintelis.ai` |
// | `SIGILANT_TASK` | the engagement's task, which carries the signed scope |
// | `SIGILANT_WAIT_SECS` | how long a held call is waited for: 300 unless set |
// | `BRIDGE_PORT` | 8795 unless set |
// | `BRIDGE_TOKEN_FILE` | optional: a bearer the agent must present |
//
// The platform's CA is trusted through NODE_EXTRA_CA_CERTS.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { SigilantClient, attestedTokens } from "@sigilant/sdk";

import { bridge } from "./bridge.ts";
import { mcpHandler } from "./mcp.ts";

const env = (name: string, fallback?: string) => {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is required`);
};

const log = (line: string) => console.log(`${new Date().toISOString()} [bridge] ${line}`);
const clientId = env("SIGILANT_CLIENT_ID");
const clientSecret = (await readFile(env("SIGILANT_CLIENT_SECRET_FILE"), "utf8")).trim();
const tokenUrl = env("SIGILANT_WORKLOAD_TOKEN_URL");
const bridgeToken = process.env.BRIDGE_TOKEN_FILE?.trim() ? (await readFile(env("BRIDGE_TOKEN_FILE"), "utf8")).trim() : undefined;

/** Its workload identity, fresh for every task token the issuer mints. */
async function workloadToken(): Promise<string> {
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
  });
  if (!response.ok) throw new Error(`the workload IdP refused ${clientId}: HTTP ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

const client = new SigilantClient({
  gateway: env("SIGILANT_GATEWAY"),
  tokens: attestedTokens(env("SIGILANT_ISSUER"), workloadToken, {
    agent: env("SIGILANT_AGENT", "bugxhunter-runner"),
    principal: env("SIGILANT_PRINCIPAL"),
    task: env("SIGILANT_TASK"),
    ttlSecs: 900,
  }),
  clientInfo: { name: "bugxhunter-bridge", version: "0.1.0" },
});

const handle = mcpHandler(bridge(client, { waitSecs: Number(env("SIGILANT_WAIT_SECS", "300")), log }), (auth) => !bridgeToken || auth === `Bearer ${bridgeToken}`, log);
const port = Number(env("BRIDGE_PORT", "8795"));
const server = createServer((req, res) => void handle(req, res));
await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
log(`listening on http://0.0.0.0:${port}/mcp as ${env("SIGILANT_AGENT", "bugxhunter-runner")} for ${env("SIGILANT_PRINCIPAL")} on ${env("SIGILANT_TASK")}, through ${env("SIGILANT_GATEWAY")}`);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
