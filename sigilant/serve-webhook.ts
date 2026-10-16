// GitHub's webhook (webhook.ts) as a process, starting runs on the runner.
//
// | Variable | |
// |---|---|
// | `WEBHOOK_PORT` | 8796 unless set |
// | `WEBHOOK_SECRET_FILE` | the secret GitHub signs deliveries with |
// | `WEBHOOK_REPOS` | the repositories served, `owner/name`, comma-separated |
// | `BXH_RUNNER` | the runner's API: `http://bxh-runner:8790` unless set |
// | `BXH_DIRECTORY` | where each engagement's folder goes: `/workspace/engagement` unless set |
// | `BXH_MODEL` | the model, as OpenCode names it; the runner's default unless set |

import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { startRun } from "./run.ts";
import { webhookHandler } from "./webhook.ts";

const env = (name: string, fallback?: string) => {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is required`);
};

const log = (line: string) => console.log(`${new Date().toISOString()} [webhook] ${line}`);
const secret = (await readFile(env("WEBHOOK_SECRET_FILE"), "utf8")).trim();
if (!secret) throw new Error("WEBHOOK_SECRET_FILE is empty");
const repos = new Set(env("WEBHOOK_REPOS").split(",").map((r) => r.trim()).filter(Boolean));
const runner = env("BXH_RUNNER", "http://bxh-runner:8790");
const root = env("BXH_DIRECTORY", "/workspace/engagement");
const model = process.env.BXH_MODEL?.trim() || undefined;

const handle = webhookHandler({
  secret,
  repos,
  root,
  log,
  async start(run) {
    await mkdir(run.directory, { recursive: true });
    return startRun(runner, { ...run, model });
  },
});
const port = Number(env("WEBHOOK_PORT", "8796"));
const server = createServer((req, res) => void handle(req, res));
await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
log(`listening on http://0.0.0.0:${port}/hooks/github for ${[...repos].join(", ")}, starting runs on ${runner}`);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
