/**
 * Amazon Bedrock, called directly: open-weight models (GLM 5.3 by default) on
 * Bedrock's OpenAI-compatible Chat Completions API,
 * `https://bedrock-runtime.<region>.amazonaws.com/openai/v1`.
 *
 * Two ways to authenticate, both held by the runner and never by the agent:
 *
 *  - AWS credentials, signing each call with SigV4. Where they come from, first
 *    match wins:
 *      1. an OIDC web identity (AWS_ROLE_ARN + AWS_WEB_IDENTITY_TOKEN_FILE): the
 *         runner exchanges the token for short-lived role credentials through
 *         STS, and again whenever they are about to expire;
 *      2. a shared profile (BEDROCK_AWS_PROFILE, else AWS_PROFILE) from
 *         ~/.aws/config: IAM Identity Center (SSO), an assumed role, or a
 *         credential process;
 *      3. access keys in the environment (AWS_ACCESS_KEY_ID, ...);
 *      4. the compute's own role (an ECS task role, EKS pod identity, an EC2
 *         instance profile): on ECS this is found by itself, elsewhere set
 *         BEDROCK_AUTH=aws.
 *  - A Bedrock API key (AWS_BEARER_TOKEN_BEDROCK), sent as a bearer token like
 *    every other provider's key. providers.ts reads it from the vault, a key
 *    file or the environment, and it wins over AWS credentials when both exist.
 *
 * AWS credentials are not vault items, so providers.ts gates them on the vault
 * instead: once a vault exists nothing is signed while it is sealed, and
 * sealing it drops the credentials held in memory here.
 *
 * Everything read from the environment here is removed from it, for the reason
 * given in providers.ts: the OpenCode server is spawned with a copy of our
 * environment, and the agent's shell inherits that.
 */
import { fromIni, fromNodeProviderChain, fromTokenFile } from "@aws-sdk/credential-providers";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { httpError } from "./errors.js";

/** What SigV4 needs. The SDK's providers return this, with an expiry for temporary credentials. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}
export type CredentialSource = () => Promise<AwsCredentials>;

/** Which of the sources above is in use. */
export type AwsAuthMode = "web-identity" | "profile" | "static" | "chain" | "none";

/** A region name, as it goes into the endpoint's host name. */
const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

function take(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  delete env[name];
  return value || undefined;
}

export interface BedrockSettings {
  region: string;
  baseUrl: string;
  mode: AwsAuthMode;
  /** For the start-up log and error messages: never a secret. */
  describe: string;
  credentials?: CredentialSource;
}

/** Read the Bedrock settings from `env`, removing the credential variables from it. */
export function readSettings(env: NodeJS.ProcessEnv = process.env): BedrockSettings {
  const named = env.BEDROCK_REGION?.trim() || env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim() || "us-east-1";
  if (!REGION.test(named)) throw new Error(`BEDROCK_REGION: "${named}" is not an AWS region name (for example ap-southeast-2).`);
  const region = named;
  const baseUrl = (env.BEDROCK_BASE_URL?.trim() || `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`).replace(/\/$/, "");

  const accessKeyId = take(env, "AWS_ACCESS_KEY_ID");
  const secretAccessKey = take(env, "AWS_SECRET_ACCESS_KEY");
  const sessionToken = take(env, "AWS_SESSION_TOKEN");
  const roleArn = take(env, "AWS_ROLE_ARN");
  const tokenFile = take(env, "AWS_WEB_IDENTITY_TOKEN_FILE");
  const sessionName = take(env, "AWS_ROLE_SESSION_NAME");
  const ownProfile = take(env, "BEDROCK_AWS_PROFILE");
  const profile = ownProfile ?? take(env, "AWS_PROFILE");
  delete env.AWS_PROFILE;
  const explicit = env.BEDROCK_AUTH?.trim().toLowerCase() === "aws";
  const onEcs = Boolean(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI);

  const base = { region, baseUrl };
  if (roleArn && tokenFile) {
    return {
      ...base, mode: "web-identity", describe: `OIDC web identity, role ${roleArn}`,
      credentials: fromTokenFile({
        roleArn, webIdentityTokenFile: tokenFile, roleSessionName: sessionName ?? "bugxhunter-runner",
        clientConfig: { region },
      }),
    };
  }
  if (profile) {
    return {
      ...base, mode: "profile", describe: `AWS profile "${profile}"`,
      credentials: fromIni({ profile, clientConfig: { region } }),
    };
  }
  if (accessKeyId && secretAccessKey) {
    const fixed: AwsCredentials = { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
    return {
      ...base, mode: "static",
      describe: sessionToken ? "temporary access keys in the environment" : "long-lived access keys in the environment",
      credentials: async () => fixed,
    };
  }
  if (explicit || onEcs) {
    return {
      ...base, mode: "chain", describe: "the compute's own AWS role",
      credentials: fromNodeProviderChain({ clientConfig: { region } }),
    };
  }
  return { ...base, mode: "none", describe: "none" };
}

/** Temporary credentials are replaced this long before they expire. */
const REFRESH_BEFORE_MS = 5 * 60_000;
/** Credentials without an expiry (a profile's static keys) are re-read this often, so a rotated file is noticed. */
const REREAD_MS = 5 * 60_000;

/**
 * Cache a credential source: one lookup for concurrent callers, and a fresh one near expiry.
 * `forget()` drops what is held, and the result of a lookup still in flight.
 */
export function cached(source: CredentialSource, now: () => number = Date.now): CredentialSource & { forget(): void } {
  let held: { value: AwsCredentials; until: number } | undefined;
  let pending: Promise<AwsCredentials> | undefined;
  let generation = 0;
  const get = async () => {
    if (held && now() < held.until) return held.value;
    if (pending) return pending;
    const mine = generation;
    const lookup: Promise<AwsCredentials> = source().then((value) => {
      if (mine === generation) {
        const expires = value.expiration?.getTime();
        held = { value, until: expires ? expires - REFRESH_BEFORE_MS : now() + REREAD_MS };
      }
      return value;
    }).finally(() => { if (pending === lookup) pending = undefined; });
    pending = lookup;
    return lookup;
  };
  return Object.assign(get, {
    forget() {
      generation += 1;
      held = undefined;
      pending = undefined;
    },
  });
}

export interface OutboundRequest {
  method: string;
  url: string;
  /** Headers to sign and send. `host` is added here. */
  headers: Record<string, string>;
  body?: string | Uint8Array;
}

/** `request`'s headers with a SigV4 signature for Bedrock added (authorization, x-amz-date, and the session token if any). */
export async function signRequest(
  request: OutboundRequest, region: string, credentials: CredentialSource | AwsCredentials, signingDate?: Date,
): Promise<Record<string, string>> {
  const url = new URL(request.url);
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) query[k] = v;
  const signer = new SignatureV4({ service: "bedrock", region, credentials, sha256: Hash.bind(null, "sha256") });
  const signed = await signer.sign({
    method: request.method.toUpperCase(),
    protocol: url.protocol,
    hostname: url.hostname,
    ...(url.port ? { port: Number(url.port) } : {}),
    path: url.pathname,
    query,
    headers: { ...request.headers, host: url.host },
    body: request.body,
  }, signingDate ? { signingDate } : undefined);
  const { host: _host, ...headers } = signed.headers as Record<string, string>;
  return headers; // fetch sets Host itself, from the same URL
}

const oneLine = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 300);

export const settings = readSettings();
const source = settings.credentials ? cached(settings.credentials) : undefined;

/** Drop the AWS credentials held in memory (the vault was locked). The next call loads them afresh. */
export const forget = () => source?.forget();

/** Whether AWS credentials are set up for Bedrock (they may still fail to load: an SSO session can lapse). */
export const awsConfigured = () => settings.mode !== "none";

/** Sign one call to Bedrock with the runner's AWS credentials. Throws a 503 the client can explain. */
export async function sign(request: OutboundRequest): Promise<Record<string, string>> {
  if (!source) throw httpError(503, "No AWS credentials for Bedrock. Set BEDROCK_AWS_PROFILE, an OIDC role, or add AWS_BEARER_TOKEN_BEDROCK to the vault.");
  let credentials: AwsCredentials;
  try {
    credentials = await source();
  } catch (e) {
    const hint = settings.mode === "profile" ? " If it is an SSO profile, sign in again with `aws sso login`." : "";
    throw httpError(503, `Could not load AWS credentials for Bedrock (${settings.describe}): ${oneLine(e)}.${hint}`);
  }
  return signRequest(request, settings.region, credentials);
}

// --- Models -------------------------------------------------------------------

export interface BedrockMeta {
  name: string; context: number; output: number; features: string[]; image?: boolean; description?: string;
  /** Not for the agent: the model cannot call tools on this route, and the agent cannot work without them. */
  chatOnly?: boolean;
}

const GLM_53 = { context: 1_000_000, output: 128_000, features: ["tools", "reasoning"] };
/**
 * OpenAI's GPT models on Bedrock. Limits as OpenAI publishes them for the same models; they read
 * images. Bedrock's Chat Completions route refuses function tools for them (its Responses route
 * takes them, which the runner does not speak), so they are for the Playground, not the agent.
 */
const GPT_ASTRA = { context: 1_050_000, output: 128_000, features: ["reasoning", "json_mode"], image: true, chatOnly: true };

/**
 * Bedrock's OpenAI-compatible route has no model list, so the ids are named in
 * BEDROCK_MODELS and the ones we know carry their limits here. GLM 5.3 has no
 * single-region form: it is called through a cross-region inference profile,
 * `global.` from most regions and `us.` from the US ones.
 */
export const BEDROCK_CATALOGUE: Record<string, BedrockMeta> = {
  "global.zai.glm-5.3": { ...GLM_53, name: "GLM 5.3 (Bedrock)", description: "Z.ai GLM 5.3 on Amazon Bedrock, through the global cross-region profile: inference may run in any commercial AWS region." },
  "us.zai.glm-5.3": { ...GLM_53, name: "GLM 5.3 (Bedrock, US)", description: "Z.ai GLM 5.3 on Amazon Bedrock, kept to US regions. Callable from US regions only." },
  "global.openai.gpt-6.2-astra": { ...GPT_ASTRA, name: "GPT-6.2 Astra (Bedrock)", description: "OpenAI GPT-6.2 Astra on Amazon Bedrock, through the global cross-region profile. Reads images. Not open-weight; sampling settings are fixed." },
  "global.openai.gpt-6-astra": { ...GPT_ASTRA, name: "GPT-6 Astra (Bedrock)", description: "OpenAI GPT-6 Astra on Amazon Bedrock, through the global cross-region profile. Reads images. Not open-weight; sampling settings are fixed." },
};

/**
 * OpenAI's hosted GPT models on Bedrock (not the open-weight gpt-oss ones), by id or by an
 * inference profile of one. They take the output limit as `max_completion_tokens`, and refuse
 * `stop` and any `temperature` or `top_p` but the default.
 */
export const isOpenAiGpt = (model: string) => /(^|[./])openai\.gpt-(?!oss)/.test(model); // `/`: an ARN ends ".../openai.gpt-..."

/** Chat parameters the hosted GPT models refuse outright or accept only at their default. */
const GPT_REFUSED = ["temperature", "top_p", "stop", "frequency_penalty", "presence_penalty"] as const;

/**
 * A chat-completions request as the Bedrock model named in it accepts it. Returns the same
 * object when there is nothing to change, so a caller can tell.
 */
export function prepareRequest<T extends Record<string, unknown>>(params: T, effort: ReasoningEffort | undefined = REASONING_EFFORT): T {
  let out: Record<string, unknown> = params;
  const change = (next: Record<string, unknown>) => { out = next; };
  if (effort && out.reasoning_effort === undefined) change({ ...out, reasoning_effort: effort });
  if (typeof out.model === "string" && isOpenAiGpt(out.model)) {
    if (GPT_REFUSED.some((k) => out[k] !== undefined)) {
      const kept = { ...out };
      for (const k of GPT_REFUSED) delete kept[k];
      change(kept);
    }
    if (out.max_tokens !== undefined) {
      const { max_tokens, ...rest } = out;
      change({ ...rest, ...(rest.max_completion_tokens === undefined ? { max_completion_tokens: max_tokens } : {}) });
    }
  }
  return out as T;
}

/**
 * A Playground request without the tools a hosted GPT model would refuse the whole call over.
 * The Playground sends whatever tools the chat has configured; the sidebar already shows such a
 * model as having no tool support. The agent's calls are not touched: there the refusal must show.
 */
export function withoutRefusedTools<T extends Record<string, unknown>>(params: T): T {
  if (typeof params.model !== "string" || !isOpenAiGpt(params.model)) return params;
  if (params.tools === undefined && params.tool_choice === undefined) return params;
  const { tools: _tools, tool_choice: _choice, ...rest } = params;
  return rest as T;
}

/** The models the agent may be offered: those in BEDROCK_MODELS that can call tools on this route. */
export const agentModels = () => BEDROCK_MODELS.filter((id) => !(BEDROCK_CATALOGUE[id]?.chatOnly ?? isOpenAiGpt(id)));

/** Whether the proxy may forward a call for this model: only the ids in BEDROCK_MODELS. */
export const allowsModel = (model: unknown): boolean => typeof model === "string" && BEDROCK_MODELS.includes(model);

/** Model or inference-profile ids the Playground and agent may use (BEDROCK_MODELS, comma list). */
export const BEDROCK_MODELS = (process.env.BEDROCK_MODELS?.trim() || "global.zai.glm-5.3")
  .split(",").map((s) => s.trim()).filter(Boolean);

/** Playground ids for Bedrock models: `bedrock/<model or inference-profile id>`. */
export const BEDROCK_PREFIX = "bedrock/";

// --- Reasoning effort -----------------------------------------------------------

/** The efforts Bedrock's Chat Completions route takes for GLM 5.3 (`none` and `minimal` are refused). */
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** BEDROCK_REASONING_EFFORT as an effort, or undefined when it is not set. Throws on anything else. */
export function readReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  if (!(REASONING_EFFORTS as readonly string[]).includes(v)) {
    throw new Error(`BEDROCK_REASONING_EFFORT: "${value}" is not one of ${REASONING_EFFORTS.join(", ")}.`);
  }
  return v as ReasoningEffort;
}

/**
 * The effort a Bedrock call gets when it names none (BEDROCK_REASONING_EFFORT). Unset, the
 * model's own default stands, which for GLM 5.3 is `max`: thorough, but reasoning counts
 * against the output limit, so a short limit can be spent before any answer is written.
 */
export const REASONING_EFFORT = readReasoningEffort(process.env.BEDROCK_REASONING_EFFORT);

/** A chat-completions body as a JSON object, or undefined when it is not one. */
function bodyObject(body: Buffer<ArrayBuffer>): Record<string, unknown> | undefined {
  if (!body.length) return undefined;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An agent's chat-completions body, as it arrives through the proxy, prepared for the model
 * it names (see prepareRequest). Anything that is not a JSON object, or needs no change, is
 * passed on byte for byte.
 */
export function prepareBody(body: Buffer<ArrayBuffer>, effort: ReasoningEffort | undefined = REASONING_EFFORT): Buffer<ArrayBuffer> {
  const parsed = bodyObject(body);
  if (!parsed) return body;
  const prepared = prepareRequest(parsed, effort);
  return prepared === parsed ? body : Buffer.from(JSON.stringify(prepared));
}

/** The model a proxied body names, if it is a JSON object that names one. */
export const bodyModel = (body: Buffer<ArrayBuffer>): unknown => bodyObject(body)?.model;
