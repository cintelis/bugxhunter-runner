// What starts a run with nobody at the keyboard: GitHub's webhook, for the
// repositories an engagement covers, and a deploy's, for its targets.
//
// | `POST /hooks/github` | a pull request opened, updated or reopened starts a review of it (run.ts); everything else is acknowledged and left alone |
// | `POST /hooks/deploy` | a deploy of a target — `{ "target": "erp:9443", "version": "1.4.2", "changed": ["/api/orders"], "note": "…" }`, posted by whatever deploys (deploy.ts, or CI) — starts a retest of what it changed |
//
// Each delivery is checked against the webhook's secret before it is read,
// and a delivery seen before is not started again: GitHub names its
// deliveries; a deploy may (`X-Deploy-Id`), and is otherwise known by its body.
//
// The scope is the gateway's to enforce: what is checked here is only that
// the repository or the target is one this receiver serves, so that a webhook
// pointed here by mistake starts nothing.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { type Run, deployPrompt, reviewPrompt } from "./run.ts";

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

/** A target, as the scope names one. */
const TARGET = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?(?::\d{1,5})?$/;
/** What a deploy may say of itself, at most. */
const MAX_VERSION_CHARS = 64;
const MAX_CHANGED = 50;
const MAX_PATH_CHARS = 200;
const MAX_NOTE_CHARS = 500;

/** A folder's worth of a name: what is not plain is a dash. */
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "unnamed";

/** What a deploy's delivery comes to: a retest of the target, or a reason to do nothing. */
export function planDeploy(payload: unknown, targets: ReadonlySet<string>, root: string, now: () => number = Date.now): Plan {
  const p = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  const target = typeof p.target === "string" ? p.target.trim() : "";
  if (!TARGET.test(target)) return { skipped: "deploy without a target (host:port)" };
  if (!targets.has(target)) return { skipped: `${target}: not a target this receiver serves` };
  const version = typeof p.version === "string" && p.version.trim() ? p.version.trim().slice(0, MAX_VERSION_CHARS) : undefined;
  const changed = Array.isArray(p.changed)
    ? p.changed.filter((c): c is string => typeof c === "string" && c.trim().length > 0).map((c) => c.trim().slice(0, MAX_PATH_CHARS)).slice(0, MAX_CHANGED)
    : [];
  const note = typeof p.note === "string" && p.note.trim() ? p.note.trim().slice(0, MAX_NOTE_CHARS) : undefined;
  const at = new Date(now()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return {
    run: { directory: `${root}/targets/${slug(target)}/deploy-${version ? slug(version) : at}`, text: deployPrompt({ target, version, changed, note }) },
    why: `deploy of ${target}${version ? ` at ${version}` : ""}${changed.length ? ` (${changed.length} path${changed.length === 1 ? "" : "s"} changed)` : ""}`,
  };
}

export interface WebhookOptions {
  secret: string;
  repos: ReadonlySet<string>;
  /** The targets whose deploys are retested; none, and a deploy starts nothing. */
  targets?: ReadonlySet<string>;
  /** Where each engagement's folder goes: `/workspace/engagement` unless set. */
  root?: string;
  /** Starts the run, and says what the session is called. */
  start(run: Run): Promise<string>;
  log?: (line: string) => void;
  /** How many delivery ids are remembered, against GitHub's retries. */
  remember?: number;
}

/** The request handler: `POST /hooks/github`, as GitHub sends it, and `POST /hooks/deploy`. */
export function webhookHandler(options: WebhookOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const log = options.log ?? (() => {});
  const root = options.root ?? "/workspace/engagement";
  const targets = options.targets ?? new Set<string>();
  const seen: string[] = [];
  const remember = options.remember ?? 1000;
  return async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    const path = new URL(req.url ?? "/", "http://hooks").pathname;
    const hook = path === "/hooks/github" ? "github" : path === "/hooks/deploy" ? "deploy" : undefined;
    if (!hook) return json(404, { error: "not a hook: /hooks/github and /hooks/deploy are" });
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
    // A deploy unnamed is known by its body: the same deploy posted twice starts once.
    const id = hook === "github" ? (header("x-github-delivery") ?? "") : `deploy:${header("x-deploy-id") ?? createHash("sha256").update(body).digest("hex")}`;
    const event = hook === "github" ? (header("x-github-event") ?? "") : "deploy";
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
    const what = hook === "github" ? plan(event, payload, options.repos, root) : planDeploy(payload, targets, root);
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
