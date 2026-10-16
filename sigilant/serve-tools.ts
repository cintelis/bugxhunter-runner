// The runner's tools behind a Sigilant gateway (tools.ts), served over TLS to
// the gateway alone: it accepts only the credential the gateway presents.
//
// | Variable | |
// |---|---|
// | `TOOLS_PORT` | 9443 unless set |
// | `TOOLS_TLS_CERT`, `TOOLS_TLS_KEY` | its certificate, from the platform's CA |
// | `TOOLS_CREDENTIAL_FILE` | the credential the gateway presents (`SIGILANT_UPSTREAM_CREDENTIAL`) |
// | `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_KEY_FILE` | the runner as a GitHub App (github-app.ts): its id, its installation on the account in scope, and its private key; preferred |
// | `GITHUB_TOKEN_FILE` | otherwise, a token of the engagement's; without either the repository tools refuse |
// | `GITHUB_API_BASE` | api.github.com unless set |
// | `FINDINGS_FILE` | where findings are kept, one JSON line each |
// | `TARGET_SCHEME` | `https` unless the targets are plain HTTP |

import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { dirname } from "node:path";

import { installationTokens } from "./github-app.ts";
import { mcpHandler } from "./mcp.ts";
import { bxhTools } from "./tools.ts";

const env = (name: string, fallback?: string) => {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is required`);
};
const fileOf = async (name: string) => (await readFile(env(name), "utf8")).trim();
const optionalFile = async (name: string) => {
  const path = process.env[name]?.trim();
  if (!path) return undefined;
  try {
    return (await readFile(path, "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
};

const log = (line: string) => console.log(`${new Date().toISOString()} [tools] ${line}`);
const port = Number(env("TOOLS_PORT", "9443"));
const credential = await fileOf("TOOLS_CREDENTIAL_FILE");
const apiBase = process.env.GITHUB_API_BASE?.trim() || undefined;
const appId = process.env.GITHUB_APP_ID?.trim();
const installationId = process.env.GITHUB_APP_INSTALLATION_ID?.trim();
const appKey = await optionalFile("GITHUB_APP_KEY_FILE");
const githubToken = await optionalFile("GITHUB_TOKEN_FILE");
// As the app where it is whole; as a token otherwise; without either, refusing.
const asApp = appId && installationId && appKey ? installationTokens({ appId, installationId, privateKeyPem: appKey, apiBase }) : undefined;
const credentialed = asApp ? `as GitHub App ${appId} (installation ${installationId})` : githubToken ? "with the engagement's GitHub token" : "with no GitHub credential, so the repository tools refuse";
if (!asApp && (appId || installationId || appKey)) log("the GitHub App is not whole: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and a non-empty GITHUB_APP_KEY_FILE are all needed");
const findingsFile = env("FINDINGS_FILE", "/findings/findings.jsonl");
await mkdir(dirname(findingsFile), { recursive: true });

const tools = bxhTools({
  github: { token: asApp ?? githubToken, apiBase },
  target: { scheme: env("TARGET_SCHEME", "https") === "http" ? "http" : "https" },
  findings: {
    async record(finding) {
      const id = `f-${randomBytes(4).toString("hex")}`;
      await appendFile(findingsFile, `${JSON.stringify({ id, ...finding })}\n`);
      log(`finding ${id} (${finding.severity}): ${finding.title}`);
      return id;
    },
  },
});

const handle = mcpHandler({ name: "bugxhunter-tools", version: "0.1.0", tools: async () => tools.tools, call: tools.call }, (auth) => auth === `Bearer ${credential}`, log);
const server = createServer({ cert: await readFile(env("TOOLS_TLS_CERT")), key: await readFile(env("TOOLS_TLS_KEY")), minVersion: "TLSv1.3" }, (req, res) => void handle(req, res));
await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
log(`listening on https://0.0.0.0:${port}/mcp, ${credentialed}`);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
