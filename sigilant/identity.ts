// The runner's identity, as a process holds it: a client-credentials token
// from the workload IdP, which the issuer checks against the registry before
// minting a task token, and a client that calls the gateway with it over the
// platform's post-quantum TLS. The bridge, a run and the webhook each hold one.
//
// | Variable | |
// |---|---|
// | `SIGILANT_ISSUER` | the issuer, for task tokens |
// | `SIGILANT_GATEWAY` | the gateway's MCP endpoint |
// | `SIGILANT_WORKLOAD_TOKEN_URL` | the workload IdP's token endpoint |
// | `SIGILANT_CLIENT_ID`, `SIGILANT_CLIENT_SECRET_FILE` | the runner's workload identity |
// | `SIGILANT_AGENT` | its registry id: `bugxhunter-runner` unless set |
// | `SIGILANT_PRINCIPAL` | who the engagement is run for, e.g. `user:nick@cintelis.ai` |
// | `SIGILANT_TASK` | the engagement's task, which carries the signed scope |
//
// The platform's CA is trusted through NODE_EXTRA_CA_CERTS.

import { readFile } from "node:fs/promises";

import { SigilantClient, attestedTokens } from "@sigilant/sdk";

/** An environment variable, trimmed; the fallback if unset; an error if neither. */
export const env = (name: string, fallback?: string): string => {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is required`);
};

/** Whether the variables an identity needs are set: a process without them does without the gateway. */
export const identityConfigured = (): boolean => Boolean(process.env.SIGILANT_ISSUER?.trim() && process.env.SIGILANT_GATEWAY?.trim());

/** A gateway client under the runner's identity, named as `clientInfo` to the gateway. */
export async function sigilantClient(clientInfo: { name: string; version: string }): Promise<SigilantClient> {
  const clientId = env("SIGILANT_CLIENT_ID");
  const clientSecret = (await readFile(env("SIGILANT_CLIENT_SECRET_FILE"), "utf8")).trim();
  const tokenUrl = env("SIGILANT_WORKLOAD_TOKEN_URL");

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

  return new SigilantClient({
    gateway: env("SIGILANT_GATEWAY"),
    tokens: attestedTokens(env("SIGILANT_ISSUER"), workloadToken, {
      agent: env("SIGILANT_AGENT", "bugxhunter-runner"),
      principal: env("SIGILANT_PRINCIPAL"),
      task: env("SIGILANT_TASK"),
      ttlSecs: 900,
    }),
    clientInfo,
  });
}
