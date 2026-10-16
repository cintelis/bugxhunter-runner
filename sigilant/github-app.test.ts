import { strict as assert } from "node:assert";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";

import { RENEW_BEFORE_MS, appJwt, installationTokens } from "./github-app.ts";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

/** The claims of a JWT whose RS256 signature checks out under the app's public key. */
function claimsOf(jwt: string): Record<string, unknown> {
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, "base64url")), "signed by the app's key");
  return JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<string, unknown>;
}

test("the app's JWT is signed with its key, names it, and lasts nine minutes from a minute ago", () => {
  assert.deepEqual(claimsOf(appJwt("5224246", pem, 1_800_000_000)), { iat: 1_799_999_940, exp: 1_800_000_540, iss: "5224246" });
});

test("an installation token is exchanged for once, held while it lasts, and renewed before it runs out", async () => {
  let clock = 1_800_000_000_000;
  const issued: { jwt: Record<string, unknown>; url: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = init?.headers as Record<string, string>;
    issued.push({ jwt: claimsOf(headers.authorization!.replace("Bearer ", "")), url: String(input) });
    assert.equal(init?.method, "POST");
    return new Response(JSON.stringify({ token: `ghs_${issued.length}`, expires_at: new Date(clock + 60 * 60_000).toISOString() }), { status: 201 });
  };
  const token = installationTokens({ appId: "5224246", installationId: "987", privateKeyPem: pem, fetch: fetchImpl, now: () => clock });
  const [a, b] = await Promise.all([token(), token()]);
  assert.equal(a, "ghs_1");
  assert.equal(b, "ghs_1", "askers at once share the one exchange");
  assert.equal(issued.length, 1);
  assert.equal(issued[0]!.url, "https://api.github.com/app/installations/987/access_tokens");
  assert.equal(issued[0]!.jwt.iss, "5224246");
  clock += 60 * 60_000 - RENEW_BEFORE_MS - 1_000;
  assert.equal(await token(), "ghs_1", "held while more than five minutes remain");
  clock += 2_000;
  assert.equal(await token(), "ghs_2", "renewed before it runs out");
  assert.equal(issued[1]!.jwt.iat, Math.floor(clock / 1000) - 60, "the JWT is minted at the clock's now");
});

test("a GitHub that will not issue one says so, and the next ask tries again", async () => {
  let status = 401;
  const fetchImpl: typeof fetch = async () => new Response(status === 401 ? "bad credentials" : JSON.stringify({ token: "ghs_ok", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status });
  const token = installationTokens({ appId: "1", installationId: "2", privateKeyPem: pem, fetch: fetchImpl });
  await assert.rejects(token(), /would not issue an installation token for app 1, installation 2: HTTP 401/);
  status = 201;
  assert.equal(await token(), "ghs_ok");
});
