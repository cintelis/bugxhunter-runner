// What starts a run with nobody at the keyboard: GitHub's webhook, for the
// repositories an engagement covers. A pull request opened, updated or
// reopened starts a review of it (run.ts); everything else is acknowledged
// and left alone. Each delivery is checked against the webhook's secret
// before it is read, and a delivery seen before is not started again.
//
// The scope is the gateway's to enforce: what is checked here is only that
// the repository is one this receiver serves, so that a webhook pointed here
// by mistake starts nothing.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { type Run, reviewPrompt } from "./run.ts";

/** Whether `signature` (`sha256=<hex>`) is the secret's over `body`. */
export function verify(secret: string, body: Buffer, signature: string | undefined): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const given = Buffer.from(signature.slice(7), "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The actions on a pull request that start a review of it. */
const REVIEWED = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

export type Plan = { run: Run; why: string } | { skipped: string };

/** What a delivery comes to: a run, or a reason to do nothing. */
export function plan(event: string, payload: unknown, repos: ReadonlySet<string>, root: string): Plan {
  const p = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  if (event === "ping") return { skipped: "ping" };
  if (event !== "pull_request") return { skipped: `${event}: not an event that starts a run` };
  const repo = (p.repository as { full_name?: unknown } | undefined)?.full_name;
  const pr = p.pull_request as { number?: unknown; draft?: unknown } | undefined;
  const action = String(p.action ?? "");
  if (typeof repo !== "string" || !repos.has(repo)) return { skipped: `${String(repo)}: not a repository this receiver serves` };
  if (!REVIEWED.has(action)) return { skipped: `pull_request ${action}: not an action that starts a review` };
  if (pr?.draft === true) return { skipped: `${repo}#${String(pr.number)}: a draft` };
  if (!Number.isInteger(pr?.number)) return { skipped: "pull_request without a number" };
  const number = pr!.number as number;
  const [owner, name] = repo.split("/");
  return {
    run: { directory: `${root}/${owner}/${name}/pr-${number}`, text: reviewPrompt(repo, number) },
    why: `${repo}#${number} ${action}`,
  };
}

export interface WebhookOptions {
  secret: string;
  repos: ReadonlySet<string>;
  /** Where each engagement's folder goes: `/workspace/engagement` unless set. */
  root?: string;
  /** Starts the run, and says what the session is called. */
  start(run: Run): Promise<string>;
  log?: (line: string) => void;
  /** How many delivery ids are remembered, against GitHub's retries. */
  remember?: number;
}

/** The request handler: `POST /hooks/github`, as GitHub sends it. */
export function webhookHandler(options: WebhookOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const log = options.log ?? (() => {});
  const root = options.root ?? "/workspace/engagement";
  const seen: string[] = [];
  const remember = options.remember ?? 1000;
  return async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const header = (name: string) => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    if (!verify(options.secret, body, header("x-hub-signature-256"))) {
      log("refused a delivery whose signature is not the secret's");
      return json(401, { error: "the signature is not this webhook's" });
    }
    const id = header("x-github-delivery") ?? "";
    const event = header("x-github-event") ?? "";
    if (id && seen.includes(id)) {
      log(`delivery ${id} seen before: nothing started again`);
      return json(202, { seen: true });
    }
    if (id) {
      seen.push(id);
      if (seen.length > remember) seen.shift();
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return json(400, { error: "not JSON" });
    }
    const what = plan(event, payload, options.repos, root);
    if ("skipped" in what) {
      log(`delivery ${id || "(unnamed)"} ${event}: ${what.skipped}`);
      return json(202, { skipped: what.skipped });
    }
    // Acknowledged first: GitHub waits ten seconds, and a run takes longer to start.
    json(202, { started: what.why });
    try {
      const session = await options.start(what.run);
      log(`${what.why}: started ${session} in ${what.run.directory}`);
    } catch (why) {
      log(`${what.why}: could not start: ${(why as Error).message}`);
    }
  };
}
