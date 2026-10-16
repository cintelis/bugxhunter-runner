import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { type Server, createServer } from "node:http";
import { after, before, test } from "node:test";

import type { Run } from "./run.ts";
import { plan, verify, webhookHandler } from "./webhook.ts";

const SECRET = "s3cret";
const REPOS = new Set(["cintelis/sigilant"]);
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
const opened = (repo = "cintelis/sigilant", action = "opened", draft = false) =>
  JSON.stringify({ action, repository: { full_name: repo }, pull_request: { number: 42, draft } });

test("a signature is the secret's over the body, and nothing else is", () => {
  const body = Buffer.from(opened());
  assert.equal(verify(SECRET, body, sign(opened())), true);
  assert.equal(verify(SECRET, body, sign(opened() + " ")), false);
  assert.equal(verify("other", body, sign(opened())), false);
  assert.equal(verify(SECRET, body, undefined), false);
  assert.equal(verify(SECRET, body, "sha1=abc"), false);
  assert.equal(verify(SECRET, body, "sha256=zz"), false, "not even hex");
});

test("a pull request opened, updated, reopened or made ready starts a review; the rest does not", () => {
  const root = "/workspace/engagement";
  for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
    const p = plan("pull_request", JSON.parse(opened("cintelis/sigilant", action)), REPOS, root);
    assert.ok("run" in p, action);
    assert.equal(p.run.directory, "/workspace/engagement/cintelis/sigilant/pr-42");
    assert.match(p.run.text, /pull request #42 of cintelis\/sigilant/);
    assert.equal(p.why, `cintelis/sigilant#42 ${action}`);
  }
  const skipped = (event: string, payload: unknown) => {
    const p = plan(event, payload, REPOS, root);
    assert.ok("skipped" in p);
    return p.skipped;
  };
  assert.equal(skipped("ping", { zen: "x" }), "ping");
  assert.match(skipped("push", {}), /not an event that starts a run/);
  assert.match(skipped("pull_request", JSON.parse(opened("someone-else/their-app"))), /not a repository this receiver serves/);
  assert.match(skipped("pull_request", JSON.parse(opened("cintelis/sigilant", "closed"))), /not an action/);
  assert.match(skipped("pull_request", JSON.parse(opened("cintelis/sigilant", "opened", true))), /a draft/);
  assert.match(skipped("pull_request", { action: "opened", repository: { full_name: "cintelis/sigilant" }, pull_request: {} }), /without a number/);
});

let server: Server;
let at: string;
const started: Run[] = [];
const lines: string[] = [];
before(async () => {
  const handle = webhookHandler({
    secret: SECRET,
    repos: REPOS,
    remember: 2,
    log: (l) => lines.push(l),
    start: async (run) => {
      started.push(run);
      if (run.directory.endsWith("pr-42")) return "ses_42";
      throw new Error("the runner is down");
    },
  });
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  at = `http://127.0.0.1:${(server.address() as { port: number }).port}/hooks/github`;
});
after(() => server.close());

const deliver = (body: string, headers: Record<string, string>) =>
  fetch(at, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(body), ...headers }, body });

test("a signed delivery of a pull request starts the review, and is acknowledged before it starts", async () => {
  const body = opened();
  const r = await deliver(body, { "x-github-event": "pull_request", "x-github-delivery": "d-1" });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { started: "cintelis/sigilant#42 opened" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(started.length, 1);
  assert.equal(started[0]!.directory, "/workspace/engagement/cintelis/sigilant/pr-42");
  assert.ok(lines.some((l) => /cintelis\/sigilant#42 opened: started ses_42/.test(l)));
});

test("the same delivery again starts nothing; a bad signature is refused; a ping is acknowledged", async () => {
  const body = opened();
  const again = await deliver(body, { "x-github-event": "pull_request", "x-github-delivery": "d-1" });
  assert.deepEqual(await again.json(), { seen: true });
  assert.equal(started.length, 1);
  const forged = await fetch(at, { method: "POST", headers: { "x-hub-signature-256": "sha256=00", "x-github-event": "pull_request" }, body });
  assert.equal(forged.status, 401);
  const ping = await deliver(JSON.stringify({ zen: "Keep it logically awesome." }), { "x-github-event": "ping", "x-github-delivery": "d-2" });
  assert.deepEqual(await ping.json(), { skipped: "ping" });
  assert.equal((await fetch(at)).status, 405);
});

test("a run the runner will not start is logged, not an error to GitHub", async () => {
  const body = JSON.stringify({ action: "opened", repository: { full_name: "cintelis/sigilant" }, pull_request: { number: 7, draft: false } });
  const r = await deliver(body, { "x-github-event": "pull_request", "x-github-delivery": "d-3" });
  assert.equal(r.status, 202);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(lines.some((l) => /cintelis\/sigilant#7 opened: could not start: the runner is down/.test(l)));
});
