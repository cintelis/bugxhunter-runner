// GitHub's webhook (webhook.ts) as a process, starting runs on the runner.
//
// | Variable | |
// |---|---|
// | `WEBHOOK_PORT` | 8796 unless set |
// | `WEBHOOK_SECRET_FILE` | the secret GitHub signs deliveries with |
// | `WEBHOOK_REPOS` | the repositories served, `owner/name`, comma-separated |
// | `WEBHOOK_TARGETS` | the targets whose deploys are retested, `host:port`, comma-separated; none unless set |
// | `BXH_RUNNER` | the runner's API: `http://bxh-runner:8790` unless set |
// | `BXH_DIRECTORY` | where each engagement's folder goes: `/workspace/engagement` unless set |
// | `BXH_MODEL` | the model, as OpenCode names it; the runner's default unless set |
// | the identity's, see identity.ts | to report each step's usage through the gateway; without them runs are started and left |

import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { env, identityConfigured, sigilantClient } from "./identity.ts";
import { startRun, usageReporter } from "./run.ts";
import { followRun } from "./usage.ts";
import { webhookHandler } from "./webhook.ts";

const log = (line: string) => console.log(`${new Date().toISOString()} [webhook] ${line}`);
const secret = (await readFile(env("WEBHOOK_SECRET_FILE"), "utf8")).trim();
if (!secret) throw new Error("WEBHOOK_SECRET_FILE is empty");
const repos = new Set(env("WEBHOOK_REPOS").split(",").map((r) => r.trim()).filter(Boolean));
const targets = new Set((process.env.WEBHOOK_TARGETS ?? "").split(",").map((t) => t.trim()).filter(Boolean));
const runner = env("BXH_RUNNER", "http://bxh-runner:8790");
const root = env("BXH_DIRECTORY", "/workspace/engagement");
const model = process.env.BXH_MODEL?.trim() || undefined;
// Each run started is followed, and each step's usage reported under the runner's identity.
const report = identityConfigured() ? usageReporter(await sigilantClient({ name: "bugxhunter-webhook", version: "0.1.0" }), log) : undefined;
if (!report) log("no Sigilant identity is configured (SIGILANT_ISSUER, SIGILANT_GATEWAY): runs are started and left, their usage unreported");

const handle = webhookHandler({
  secret,
  repos,
  targets,
  root,
  log,
  async start(run) {
    await mkdir(run.directory, { recursive: true });
    const id = await startRun(runner, { ...run, model });
    if (report) {
      void followRun(runner, id, run.directory, report, { log })
        .then((steps) => log(`${id} is idle: ${steps.length} step${steps.length === 1 ? "" : "s"} reported`))
        .catch((why: Error) => log(`following ${id} failed: ${why.message}`));
    }
    return id;
  },
});
const port = Number(env("WEBHOOK_PORT", "8796"));
const server = createServer((req, res) => void handle(req, res));
await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
log(`listening on http://0.0.0.0:${port}/hooks/github for ${[...repos].join(", ")} and /hooks/deploy for ${[...targets].join(", ") || "no target"}, starting runs on ${runner}`);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
