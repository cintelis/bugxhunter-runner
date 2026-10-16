// The runner on GitHub as a GitHub App — BugXHunter's own name and logo on
// every comment and review, and an installation a customer consents to —
// rather than as a person's token. An app proves itself with a short-lived
// JWT signed by its private key and exchanges it for an installation token,
// good for an hour on the repositories the installation covers; the token is
// what the repository tools then present, renewed before it runs out.
//
// GitHub requires the app JWT to be RS256: RSA, which is classical. That is
// GitHub's, confined to this file, and nothing of the Sigilant platform's.

import { createSign } from "node:crypto";

const base64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** A JWT GitHub takes as the app's, good for nine minutes: `iat` a minute back, as GitHub allows for clock drift. */
export function appJwt(appId: string, privateKeyPem: string, nowSecs = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSecs - 60, exp: nowSecs + 540, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).end().sign(privateKeyPem).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export interface AppOptions {
  /** The app's id (or client id), as its settings page shows it. */
  appId: string;
  /** The installation on the account whose repositories are in scope. */
  installationId: string;
  privateKeyPem: string;
  apiBase?: string;
  fetch?: typeof fetch;
  /** The clock, in ms; for tests. */
  now?: () => number;
}

/** How long before an installation token runs out it is renewed. */
export const RENEW_BEFORE_MS = 5 * 60_000;

/**
 * The installation's token, fresh when asked for: the one held while it has
 * more than five minutes to run, a new one otherwise. Askers at once share
 * the one exchange.
 */
export function installationTokens(app: AppOptions): () => Promise<string> {
  const fetchImpl = app.fetch ?? fetch;
  const api = app.apiBase ?? "https://api.github.com";
  let held: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;
  return async () => {
    const now = (app.now ?? Date.now)();
    if (held && held.expiresAt - now > RENEW_BEFORE_MS) return held.token;
    pending ??= (async () => {
      try {
        const response = await fetchImpl(`${api}/app/installations/${encodeURIComponent(app.installationId)}/access_tokens`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${appJwt(app.appId, app.privateKeyPem, Math.floor(now / 1000))}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "bugxhunter-sigilant",
          },
        });
        if (!response.ok) {
          throw new Error(`GitHub would not issue an installation token for app ${app.appId}, installation ${app.installationId}: HTTP ${response.status}`);
        }
        const { token, expires_at } = (await response.json()) as { token: string; expires_at: string };
        held = { token, expiresAt: Date.parse(expires_at) };
        return token;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
}
