// Tells the webhook a deploy has happened, so that the target is retested:
// what CI runs after it deploys, or the host after it recreates a target.
//
//   node sigilant/deploy.ts --target erp:9443 --version 1.4.2 --changed /api/orders,/api/invoices --note "orders rewritten"
//
// | Variable | |
// |---|---|
// | `WEBHOOK_URL` | where to post: `http://bxh-webhook:8796/hooks/deploy` unless set |
// | `WEBHOOK_SECRET_FILE` | the secret the webhook checks deliveries against |
//
// The delivery is signed as GitHub signs its own (X-Hub-Signature-256) and
// named by X-Deploy-Id, so that the same deploy posted twice starts once.

import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Deploy } from "./run.ts";

/** Posts `deploy` to the webhook, signed; what the webhook answered. */
export async function postDeploy(url: string, secret: string, deploy: Deploy, options: { id?: string; fetchImpl?: typeof fetch } = {}): Promise<{ status: number; body: unknown }> {
  const body = JSON.stringify(deploy);
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      "x-deploy-id": options.id ?? `${deploy.target}@${deploy.version ?? randomBytes(6).toString("hex")}`,
    },
    body,
  });
  const text = await response.text();
  let answer: unknown = text;
  try {
    answer = JSON.parse(text);
  } catch {
    // Not JSON: kept as text.
  }
  return { status: response.status, body: answer };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const target = at("--target");
  if (!target) {
    console.error("usage: node sigilant/deploy.ts --target host:port [--version v] [--changed /a,/b] [--note …]");
    process.exit(2);
  }
  const secretFile = process.env.WEBHOOK_SECRET_FILE?.trim();
  if (!secretFile) throw new Error("WEBHOOK_SECRET_FILE is required");
  const secret = (await readFile(secretFile, "utf8")).trim();
  const changed = (at("--changed") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const { status, body } = await postDeploy(process.env.WEBHOOK_URL?.trim() || "http://bxh-webhook:8796/hooks/deploy", secret, {
    target,
    version: at("--version"),
    changed,
    note: at("--note"),
  });
  console.log(`${status} ${JSON.stringify(body)}`);
  process.exit(status === 202 ? 0 : 1);
}
