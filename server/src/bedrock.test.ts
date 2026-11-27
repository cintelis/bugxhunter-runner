import { describe, expect, it } from "vitest";
import { bodyModel, cached, isOpenAiGpt, prepareBody, prepareRequest, readReasoningEffort, readSettings, signRequest, withoutRefusedTools, type AwsCredentials } from "./bedrock.js";

const KEYS = { AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "not-a-real-secret" };

describe("Bedrock settings", () => {
  it("has no AWS credentials unless something names them", () => {
    const s = readSettings({});
    expect(s).toMatchObject({ mode: "none", region: "us-east-1", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1" });
    expect(s.credentials).toBeUndefined();
    // An instance or default profile is used only when asked for, never by surprise.
    expect(readSettings({ BEDROCK_AUTH: "aws" }).mode).toBe("chain");
    expect(readSettings({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/x" }).mode).toBe("chain");
  });

  it("takes the region from BEDROCK_REGION, then AWS's own variables, and builds the endpoint from it", () => {
    expect(readSettings({ AWS_DEFAULT_REGION: "eu-west-1" }).region).toBe("eu-west-1");
    expect(readSettings({ AWS_REGION: "us-west-2", AWS_DEFAULT_REGION: "eu-west-1" }).region).toBe("us-west-2");
    const s = readSettings({ BEDROCK_REGION: "ap-southeast-2", AWS_REGION: "us-west-2" });
    expect(s.baseUrl).toBe("https://bedrock-runtime.ap-southeast-2.amazonaws.com/openai/v1");
    expect(readSettings({ BEDROCK_REGION: "us-gov-west-1" }).region).toBe("us-gov-west-1");
  });

  it("refuses a region that is not a region name (it becomes part of a host name)", () => {
    for (const bad of ["evil.example/x", "ap-southeast-2.attacker.test", "AP-SOUTHEAST-2", "sydney"]) {
      expect(() => readSettings({ BEDROCK_REGION: bad }), bad).toThrow(/not an AWS region/);
    }
  });

  it("picks an OIDC role first, then a profile, then keys", () => {
    const oidc = { AWS_ROLE_ARN: "arn:aws:iam::111122223333:role/runner", AWS_WEB_IDENTITY_TOKEN_FILE: "/run/token" };
    expect(readSettings({ ...oidc, AWS_PROFILE: "dev", ...KEYS })).toMatchObject({ mode: "web-identity", describe: "OIDC web identity, role arn:aws:iam::111122223333:role/runner" });
    expect(readSettings({ AWS_PROFILE: "dev", ...KEYS })).toMatchObject({ mode: "profile", describe: 'AWS profile "dev"' });
    expect(readSettings({ BEDROCK_AWS_PROFILE: "models", AWS_PROFILE: "dev" }).describe).toBe('AWS profile "models"');
    expect(readSettings({ ...KEYS })).toMatchObject({ mode: "static", describe: "long-lived access keys in the environment" });
    expect(readSettings({ ...KEYS, AWS_SESSION_TOKEN: "t" }).describe).toBe("temporary access keys in the environment");
    // Half an OIDC setup is not one.
    expect(readSettings({ AWS_ROLE_ARN: oidc.AWS_ROLE_ARN }).mode).toBe("none");
  });

  it("removes what it read from the environment, so the agent's shell does not inherit it", () => {
    const env: NodeJS.ProcessEnv = {
      ...KEYS, AWS_SESSION_TOKEN: "t", AWS_PROFILE: "dev", BEDROCK_AWS_PROFILE: "models",
      AWS_ROLE_ARN: "arn:aws:iam::111122223333:role/runner", AWS_WEB_IDENTITY_TOKEN_FILE: "/run/token", AWS_ROLE_SESSION_NAME: "s",
      PATH: "/usr/bin",
    };
    readSettings(env);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("never puts a secret in the description", async () => {
    const s = readSettings({ ...KEYS, AWS_SESSION_TOKEN: "session-secret" });
    expect(s.describe).not.toMatch(/AKIDEXAMPLE|not-a-real-secret|session-secret/);
    expect(await s.credentials!()).toEqual({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "not-a-real-secret", sessionToken: "session-secret" });
  });
});

describe("SigV4 signing for Bedrock", () => {
  const creds: AwsCredentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "not-a-real-secret" };
  const at = new Date("2026-11-25T03:04:05Z");
  const request = {
    method: "post", url: "https://bedrock-runtime.ap-southeast-2.amazonaws.com/openai/v1/chat/completions",
    headers: { "Content-Type": "application/json", Accept: "*/*" }, body: '{"model":"global.zai.glm-5.3"}',
  };

  it("signs for the bedrock service in the region, over the headers it is given", async () => {
    const h = await signRequest(request, "ap-southeast-2", creds, at);
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261125\/ap-southeast-2\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(h["x-amz-date"]).toBe("20261125T030405Z");
    expect(h["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(h["Content-Type"]).toBe("application/json");
    expect(h).not.toHaveProperty("host"); // fetch sets it
    expect(h).not.toHaveProperty("x-amz-security-token");
    expect(JSON.stringify(h)).not.toContain("not-a-real-secret");
  });

  it("is deterministic, and covers the body and the URL", async () => {
    const sig = async (r: typeof request) => (await signRequest(r, "ap-southeast-2", creds, at)).authorization;
    expect(await sig(request)).toBe(await sig({ ...request }));
    expect(await sig({ ...request, body: '{"model":"other"}' })).not.toBe(await sig(request));
    expect(await sig({ ...request, url: request.url.replace("chat/completions", "responses") })).not.toBe(await sig(request));
    // Bytes and the same text sign alike: the proxy signs the agent's raw body.
    const bytes = await signRequest({ ...request, body: new TextEncoder().encode(request.body) }, "ap-southeast-2", creds, at);
    expect(bytes.authorization).toBe(await sig(request));
  });

  it("sends the session token of temporary credentials", async () => {
    const h = await signRequest(request, "ap-southeast-2", { ...creds, sessionToken: "session-token" }, at);
    expect(h["x-amz-security-token"]).toBe("session-token");
  });
});

describe("the default reasoning effort", () => {
  const body = (o: unknown) => Buffer.from(JSON.stringify(o));
  const parsed = (b: Buffer) => JSON.parse(b.toString("utf8"));

  it("reads BEDROCK_REASONING_EFFORT, and refuses a value Bedrock would refuse", () => {
    expect(readReasoningEffort(undefined)).toBeUndefined();
    expect(readReasoningEffort("  ")).toBeUndefined();
    expect(readReasoningEffort(" Medium ")).toBe("medium");
    for (const bad of ["none", "minimal", "fast", "5"]) expect(() => readReasoningEffort(bad), bad).toThrow(/not one of low, medium, high, xhigh, max/);
  });

  it("is added to an agent's call that names none", () => {
    const sent = parsed(prepareBody(body({ model: "global.zai.glm-5.3", messages: [], stream: true }), "medium"));
    expect(sent).toEqual({ model: "global.zai.glm-5.3", messages: [], stream: true, reasoning_effort: "medium" });
  });

  it("leaves a call alone when it sets its own effort, when there is no default, or when it is not a JSON object", () => {
    const own = body({ model: "m", reasoning_effort: "max" });
    expect(prepareBody(own, "low")).toBe(own);
    const plain = body({ model: "m" });
    expect(prepareBody(plain, undefined)).toBe(plain);
    for (const odd of [Buffer.from("not json"), Buffer.from("[1,2]"), Buffer.from("null"), Buffer.alloc(0)]) {
      expect(prepareBody(odd, "low")).toBe(odd);
    }
  });
});

describe("requests for OpenAI's GPT models on Bedrock", () => {
  const astra = "global.openai.gpt-6.2-astra";

  it("tells the hosted GPT models from the rest", () => {
    for (const id of [astra, "global.openai.gpt-6-astra", "openai.gpt-6.2-sol", "us.openai.gpt-5.5", "arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-6.2-astra"]) expect(isOpenAiGpt(id), id).toBe(true);
    for (const id of ["global.zai.glm-5.3", "openai.gpt-oss-120b-1:0", "anthropic.claude-opus-5-5", "myopenai.gpt-x", "arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-oss-120b-1:0"]) expect(isOpenAiGpt(id), id).toBe(false);
  });

  it("sends the output limit as max_completion_tokens, and drops what the model refuses", () => {
    const sent = prepareRequest({
      model: astra, messages: [], stream: true, max_tokens: 4096, temperature: 0.7, top_p: 1, stop: ["x"],
      frequency_penalty: 0, presence_penalty: 0, reasoning_effort: "medium", tools: [], response_format: { type: "json_object" },
    }, undefined);
    expect(sent).toEqual({
      model: astra, messages: [], stream: true, max_completion_tokens: 4096,
      reasoning_effort: "medium", tools: [], response_format: { type: "json_object" },
    });
  });

  it("keeps a max_completion_tokens the caller set itself", () => {
    expect(prepareRequest({ model: astra, max_tokens: 100, max_completion_tokens: 900 }, undefined)).toEqual({ model: astra, max_completion_tokens: 900 });
  });

  it("leaves other models' requests as they are, the same object", () => {
    const glm = { model: "global.zai.glm-5.3", max_tokens: 4096, temperature: 0.2, stop: ["x"] };
    expect(prepareRequest(glm, undefined)).toBe(glm);
    const fine = { model: astra, max_completion_tokens: 10 };
    expect(prepareRequest(fine, undefined)).toBe(fine);
  });

  it("applies the default effort and the GPT rules together, to an agent's raw body too", () => {
    const body = Buffer.from(JSON.stringify({ model: astra, max_tokens: 8000, temperature: 0 }));
    expect(JSON.parse(prepareBody(body, "low").toString("utf8"))).toEqual({ model: astra, max_completion_tokens: 8000, reasoning_effort: "low" });
  });

  it("drops tools from a Playground request to a GPT model, and from no other", () => {
    const tools = [{ type: "function", function: { name: "f" } }];
    expect(withoutRefusedTools({ model: astra, messages: [], tools, tool_choice: "auto" })).toEqual({ model: astra, messages: [] });
    const glm = { model: "global.zai.glm-5.3", tools };
    expect(withoutRefusedTools(glm)).toBe(glm);
    const none = { model: astra, messages: [] };
    expect(withoutRefusedTools(none)).toBe(none);
  });

  it("reads the model a proxied body names", () => {
    expect(bodyModel(Buffer.from(JSON.stringify({ model: astra })))).toBe(astra);
    for (const odd of [Buffer.from("not json"), Buffer.from("[]"), Buffer.alloc(0), Buffer.from("{}")]) expect(bodyModel(odd)).toBeUndefined();
  });
});

describe("the credential cache", () => {
  it("asks once for concurrent callers and again shortly before expiry", async () => {
    let now = 1_000_000, calls = 0;
    const source = cached(async () => {
      calls += 1;
      return { accessKeyId: `K${calls}`, secretAccessKey: "s", expiration: new Date(now + 60 * 60_000) };
    }, () => now);
    const [a, b] = await Promise.all([source(), source()]);
    expect([a.accessKeyId, b.accessKeyId, calls]).toEqual(["K1", "K1", 1]);
    now += 50 * 60_000;
    expect((await source()).accessKeyId).toBe("K1");
    now += 6 * 60_000; // inside the last five minutes
    expect((await source()).accessKeyId).toBe("K2");
  });

  it("forgets on request, and loads afresh on the next call", async () => {
    let calls = 0;
    const source = cached(async () => {
      calls += 1;
      return { accessKeyId: `K${calls}`, secretAccessKey: "s", expiration: new Date(Date.now() + 60 * 60_000) };
    });
    expect((await source()).accessKeyId).toBe("K1");
    source.forget();
    expect(calls).toBe(1); // forgetting loads nothing
    expect((await source()).accessKeyId).toBe("K2");
    expect((await source()).accessKeyId).toBe("K2");
  });

  it("does not keep the result of a lookup that was in flight when it forgot", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const source = cached(async () => {
      calls += 1;
      const n = calls;
      if (n === 1) await gate;
      return { accessKeyId: `K${n}`, secretAccessKey: "s", expiration: new Date(Date.now() + 60 * 60_000) };
    });
    const first = source();
    source.forget(); // the vault was locked while STS was still answering
    release();
    expect((await first).accessKeyId).toBe("K1"); // the caller already waiting gets its answer
    expect((await source()).accessKeyId).toBe("K2"); // but it was not kept
  });

  it("re-reads credentials that have no expiry, and does not keep a failure", async () => {
    let now = 0, calls = 0, fail = true;
    const source = cached(async () => {
      calls += 1;
      if (fail) throw new Error("Token is expired");
      return { accessKeyId: `K${calls}`, secretAccessKey: "s" };
    }, () => now);
    await expect(source()).rejects.toThrow(/expired/);
    fail = false; // the operator signed in again
    expect((await source()).accessKeyId).toBe("K2");
    now += 4 * 60_000;
    expect((await source()).accessKeyId).toBe("K2");
    now += 2 * 60_000;
    expect((await source()).accessKeyId).toBe("K3");
  });
});
