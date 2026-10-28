/**
 * Model providers. SCX.ai is the default; OpenRouter is optional and opens up
 * its catalogue (https://openrouter.ai/models). Both speak the OpenAI API, so
 * one client class and one key-injecting proxy serve both.
 *
 * Keys: the vault item (SCX_API, OPENROUTER_API_KEY) first, then a key file
 * (SCX_API_FILE, OPENROUTER_API_KEY_FILE), then .env, then OpenCode's own auth
 * store. A key file is for a runner nobody is at the keyboard of, where the
 * vault cannot be unlocked: a mounted secret, re-read on every call so that
 * replacing the file rotates the key without a restart. Keys in the
 * environment are read once here and scrubbed from it, and so are the key
 * files' paths: the OpenCode server is spawned with a copy of our environment,
 * and the agent's shell inherits that.
 *
 * In the Playground, OpenRouter models are addressed as `openrouter/<id>`.
 * For the agent, OPENROUTER_MODELS (comma list of OpenRouter ids) is turned
 * into an OpenCode provider that calls back through the runner's proxy, so
 * the key stays here in both local and Docker modes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SCXModel } from "../../shared/scx.js";
import { SCXClient } from "./scx.js";
import { httpError } from "./errors.js";
import * as vault from "./vault.js";

export type ProviderId = "scx" | "openrouter" | "nvidia";
export type KeySource = "vault" | "file" | "env" | "opencode-auth" | "none";

export interface ProviderDef {
  id: ProviderId;
  name: string;
  baseUrl: string;
  /** Vault item holding the key. */
  vaultItem: string;
  /** Environment variables that may hold it (first wins). */
  envVars: string[];
  /** Environment variable naming a file that holds it. */
  fileVar: string;
  /** Provider id in OpenCode's ~/.local/share/opencode/auth.json. */
  authId: string;
  headers?: Record<string, string>;
}

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  scx: {
    id: "scx", name: "SCX.ai", baseUrl: process.env.SCX_BASE_URL ?? "https://api.scx.ai/v1",
    vaultItem: "SCX_API", envVars: ["SCX_API", "SCX_API_KEY"], fileVar: "SCX_API_FILE", authId: "scx",
  },
  openrouter: {
    id: "openrouter", name: "OpenRouter", baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    vaultItem: "OPENROUTER_API_KEY", envVars: ["OPENROUTER_API_KEY"], fileVar: "OPENROUTER_API_KEY_FILE", authId: "openrouter",
    // Attribution headers OpenRouter asks apps to send.
    headers: { "HTTP-Referer": "https://bugxhunter.com", "X-Title": "BugXHunter" },
  },
  nvidia: {
    id: "nvidia", name: "NVIDIA NIM", baseUrl: process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
    // `NVIDI_NGC_POC` is the name the NGC proof-of-concept key already uses in .env; `NVIDIA_API_KEY` is the tidy one.
    vaultItem: "NVIDIA_API_KEY", envVars: ["NVIDIA_API_KEY", "NVIDI_NGC_POC"], fileVar: "NVIDIA_API_KEY_FILE", authId: "nvidia",
  },
};

/** OpenRouter ids the agent may use (OPENROUTER_MODELS=anthropic/claude-sonnet-4.5,openai/gpt-6.1-sol). */
export const OPENROUTER_MODELS = (process.env.OPENROUTER_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * NVIDIA NIM (build.nvidia.com) is OpenAI-compatible but its `/v1/models` carries
 * thin metadata and lists decommissioned endpoints, so we curate the models we
 * expose rather than mirroring the whole catalogue. Playground ids are prefixed
 * `nim/` (the upstream id keeps its own org prefix, e.g. `nim/z-ai/glm-5.3`).
 * Context/output limits are best-effort; NVIDIA rotates hosted endpoints, so
 * re-probe before relying on any one. The free trial tier is ~40 req/min.
 * Override the list with NVIDIA_MODELS (comma-separated upstream ids).
 */
interface NvidiaMeta { name: string; context: number; output: number; image?: boolean; features: string[]; description?: string; }
const NVIDIA_CATALOGUE: Record<string, NvidiaMeta> = {
  "z-ai/glm-5.3": { name: "GLM-5.3 (NVIDIA)", context: 200_000, output: 32_000, features: ["tools", "reasoning", "json_mode"], description: "Z.ai GLM-5.3 served on NVIDIA NIM — the same family as the SCX default." },
  "z-ai/glm-5.3-flash": { name: "GLM-5.3 Flash (NVIDIA)", context: 200_000, output: 32_000, features: ["tools", "json_mode"], description: "Faster GLM-5.3 variant on NVIDIA NIM." },
  "nvidia/nemotron-3-ultra-550b-a55b": { name: "Nemotron 3 Ultra 550B", context: 128_000, output: 32_000, features: ["tools", "reasoning", "json_mode"], description: "NVIDIA's strongest open reasoning model; good for the agent when depth matters." },
  "deepseek-ai/deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", context: 128_000, output: 16_000, features: ["tools", "json_mode"], description: "Fast DeepSeek chat/agent model." },
  "nvidia/nemotron-3.5-lightning-30b-a3b": { name: "Nemotron 3.5 Lightning 30B", context: 128_000, output: 16_000, features: ["tools", "json_mode"], description: "Fast Nemotron for quick turns." },
  "nvidia/nemotron-3.5-super-vl-120b-a12b": { name: "Nemotron 3.5 Super VL 120B", context: 128_000, output: 16_000, image: true, features: ["tools", "json_mode"], description: "Vision-language Nemotron; reads images (good for the vision subagent)." },
};
/** Upstream NVIDIA ids the Playground and agent may use (default = the curated set above). */
export const NVIDIA_MODELS = (process.env.NVIDIA_MODELS ?? Object.keys(NVIDIA_CATALOGUE).join(","))
  .split(",").map((s) => s.trim()).filter(Boolean);

export const PORT = Number(process.env.PORT ?? 8790);
/**
 * The token the agent presents to the proxy. From .env in Docker (both
 * containers read it); random per process in local mode, where it is handed
 * to the OpenCode child inside its inline config rather than the environment.
 */
export const PROXY_TOKEN = process.env.SCX_PROXY_TOKEN || crypto.randomBytes(24).toString("base64url");

function readAuthStore(): Record<string, string> {
  try {
    const file = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { key?: string }>;
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v?.key ?? ""]));
  } catch {
    return {};
  }
}

const envKeys: Partial<Record<ProviderId, string>> = {};
const keyFiles: Partial<Record<ProviderId, string>> = {};
const authKeys = readAuthStore();
for (const p of Object.values(PROVIDERS)) {
  for (const v of p.envVars) if (process.env[v]) { envKeys[p.id] = process.env[v]!; break; }
  for (const v of p.envVars) delete process.env[v];
  if (process.env[p.fileVar]?.trim()) keyFiles[p.id] = process.env[p.fileVar]!.trim();
  delete process.env[p.fileVar];
}

/** The key in a provider's key file, read now; undefined if it has none, or it is empty. */
function fileKey(id: ProviderId): string | undefined {
  const file = keyFiles[id];
  if (!file) return undefined;
  try {
    return fs.readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
for (const k of ["SCX_PROXY_TOKEN", "OPEN_RUNNER_SECRET"]) delete process.env[k];

/** Where a provider's key comes from right now. */
export function keySource(id: ProviderId): KeySource {
  const p = PROVIDERS[id];
  if (vault.isInitialised() && vault.status("none").items.includes(p.vaultItem)) return "vault";
  if (keyFiles[id]) return "file";
  if (envKeys[id]) return "env";
  if (authKeys[p.authId]) return "opencode-auth";
  return "none";
}

export const configured = (id: ProviderId) => keySource(id) !== "none";

/** The key for this call. Throws a 503 the client can explain (vault sealed, no key). */
export function apiKey(id: ProviderId): string {
  const p = PROVIDERS[id];
  switch (keySource(id)) {
    case "vault": return vault.getItem(p.vaultItem)!; // throws 503 while sealed
    case "file": {
      const key = fileKey(id);
      // A key file named and then not readable is a fault, never a reason to fall back to a key in the clear.
      if (!key) throw httpError(503, `The ${p.name} key file ${p.fileVar} names cannot be read, or is empty.`);
      return key;
    }
    case "env": return envKeys[id]!;
    case "opencode-auth": return authKeys[p.authId];
    default:
      throw httpError(503, id === "scx"
        ? "No SCX API key. Set up the vault in the sidebar, or run `opencode auth login` (provider id: scx)."
        : `No ${p.name} key. Add ${p.vaultItem} to the vault (keys dialog) to use ${p.name} models.`);
  }
}

export const clients: Record<ProviderId, SCXClient> = {
  scx: new SCXClient({ apiKey: () => apiKey("scx"), baseUrl: PROVIDERS.scx.baseUrl }),
  openrouter: new SCXClient({ apiKey: () => apiKey("openrouter"), baseUrl: PROVIDERS.openrouter.baseUrl, headers: PROVIDERS.openrouter.headers }),
  nvidia: new SCXClient({ apiKey: () => apiKey("nvidia"), baseUrl: PROVIDERS.nvidia.baseUrl }),
};

/** Playground model ids: SCX ids as-is, OpenRouter ids prefixed `openrouter/`, NVIDIA NIM ids `nim/`. */
export function clientFor(model: string): { client: SCXClient; model: string; provider: ProviderId } {
  if (model.startsWith("openrouter/")) return { client: clients.openrouter, model: model.slice("openrouter/".length), provider: "openrouter" };
  if (model.startsWith("nim/")) return { client: clients.nvidia, model: model.slice("nim/".length), provider: "nvidia" };
  return { client: clients.scx, model, provider: "scx" };
}

// --- OpenRouter's catalogue, in the shape the Playground already understands ----

interface OpenRouterModel {
  id: string;
  name?: string;
  created?: number;
  description?: string;
  context_length?: number | null;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  top_provider?: { max_completion_tokens?: number | null };
  pricing?: Record<string, string>;
  supported_parameters?: string[];
}

const SAMPLING = new Set(["temperature", "top_p", "top_k", "max_tokens", "stop", "frequency_penalty", "presence_penalty", "repetition_penalty", "seed", "min_p", "top_a"]);

export function normaliseOpenRouter(m: OpenRouterModel): SCXModel {
  const params = m.supported_parameters ?? [];
  const features: string[] = [];
  if (params.includes("tools") || params.includes("tool_choice")) features.push("tools");
  if (params.includes("response_format") || params.includes("structured_outputs")) features.push("json_mode");
  if (params.includes("reasoning") || params.includes("include_reasoning")) features.push("reasoning");
  return {
    id: `openrouter/${m.id}`,
    name: m.name ?? m.id,
    created: m.created ?? 0,
    input_modalities: m.architecture?.input_modalities ?? ["text"],
    output_modalities: m.architecture?.output_modalities ?? ["text"],
    context_length: m.context_length ?? null,
    max_output_length: m.top_provider?.max_completion_tokens ?? null,
    pricing: m.pricing ?? {},
    supported_sampling_parameters: params.filter((p) => SAMPLING.has(p)),
    supported_features: features,
    description: m.description,
    provider: "openrouter",
  };
}

/** OpenRouter's catalogue is public: no key needed, so limits are known even while the vault is sealed. */
async function openRouterCatalogue(): Promise<OpenRouterModel[]> {
  const r = await fetch(`${PROVIDERS.openrouter.baseUrl}/models`, { headers: PROVIDERS.openrouter.headers, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`OpenRouter /models replied ${r.status}`);
  return ((await r.json()) as { data: OpenRouterModel[] }).data ?? [];
}

/** A curated NVIDIA NIM model as an SCXModel (Playground id `nim/<upstream id>`). */
export function nvidiaModel(id: string, meta: NvidiaMeta): SCXModel {
  return {
    id: `nim/${id}`,
    name: meta.name,
    created: 0,
    input_modalities: meta.image ? ["text", "image"] : ["text"],
    output_modalities: ["text"],
    context_length: meta.context,
    max_output_length: meta.output,
    pricing: {}, // free trial tier — no per-token price
    supported_sampling_parameters: ["temperature", "top_p", "max_tokens", "stop", "frequency_penalty", "presence_penalty", "seed"],
    supported_features: meta.features,
    description: meta.description,
    provider: "nvidia",
  };
}

/** NVIDIA NIM's live model ids (its /v1/models). Keyed, so the vault must be open. */
async function nvidiaCatalogueLive(): Promise<string[]> {
  const r = await fetch(`${PROVIDERS.nvidia.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey("nvidia")}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`NVIDIA /models replied ${r.status}`);
  const data = ((await r.json()) as { data?: { id?: string }[] }).data ?? [];
  return data.map((m) => m.id).filter((id): id is string => Boolean(id));
}

/** A live NVIDIA model without curated metadata: the raw id with best-effort defaults. */
function nvidiaLiveModel(id: string): SCXModel {
  return {
    id: `nim/${id}`,
    name: id,
    created: 0,
    input_modalities: ["text"],
    output_modalities: ["text"],
    context_length: null,
    max_output_length: null,
    pricing: {},
    supported_sampling_parameters: ["temperature", "top_p", "max_tokens", "stop", "frequency_penalty", "presence_penalty", "seed"],
    supported_features: [],
    description: "NVIDIA NIM model from the live catalogue (metadata not curated; some endpoints are non-chat or may be unavailable).",
    provider: "nvidia",
  };
}

/**
 * NVIDIA NIM models for the Playground: the full live catalogue (its /v1/models),
 * same list the agent discovers, with curated metadata merged in for the known
 * models. Falls back to the curated set if the catalogue can't be fetched (e.g.
 * the vault is sealed, so there is no key to query it with).
 */
async function nvidiaModels(): Promise<SCXModel[]> {
  if (!configured("nvidia")) return [];
  const curated = () => NVIDIA_MODELS.filter((id) => NVIDIA_CATALOGUE[id]).map((id) => nvidiaModel(id, NVIDIA_CATALOGUE[id]));
  try {
    const ids = await nvidiaCatalogueLive();
    if (!ids.length) return curated();
    return ids
      .map((id) => (NVIDIA_CATALOGUE[id] ? nvidiaModel(id, NVIDIA_CATALOGUE[id]) : nvidiaLiveModel(id)))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    console.error("[nvidia] model list failed:", (e as Error).message);
    return curated();
  }
}

/** Every model the Playground can use: SCX's, plus OpenRouter's and NVIDIA's when their keys are configured. */
export async function listModels(): Promise<SCXModel[]> {
  const scx = (await clients.scx.listModels()).map((m) => ({ ...m, provider: "scx" as const }));
  const nvidia = await nvidiaModels();
  if (!configured("openrouter")) return [...scx, ...nvidia];
  try {
    const all = (await openRouterCatalogue()).map(normaliseOpenRouter);
    const allow = new Set(OPENROUTER_MODELS.map((id) => `openrouter/${id}`));
    const picked = allow.size ? all.filter((m) => allow.has(m.id)) : all;
    return [...scx, ...nvidia, ...picked.sort((a, b) => a.name.localeCompare(b.name))];
  } catch (e) {
    console.error("[openrouter] model list failed:", (e as Error).message);
    return [...scx, ...nvidia];
  }
}

/**
 * An OpenCode provider for the agent, calling back through the runner's
 * proxy with the proxy token, for the models in OPENROUTER_MODELS. Context
 * and output limits come from OpenRouter's public catalogue; defaults if it
 * is unreachable.
 */
export async function openrouterOpencodeProvider(proxyBaseUrl: string): Promise<Record<string, unknown> | null> {
  if (!OPENROUTER_MODELS.length) return null;
  const limits = new Map<string, { context?: number | null; output?: number | null; images?: boolean }>();
  try {
    for (const m of await openRouterCatalogue()) {
      limits.set(m.id, { context: m.context_length, output: m.top_provider?.max_completion_tokens, images: m.architecture?.input_modalities?.includes("image") });
    }
    for (const id of OPENROUTER_MODELS) if (!limits.has(id)) console.error(`[openrouter] OPENROUTER_MODELS: "${id}" is not in OpenRouter's catalogue (check the id)`);
  } catch (e) {
    console.error("[openrouter] could not fetch model limits, using defaults:", (e as Error).message);
  }
  const models: Record<string, unknown> = {};
  for (const id of OPENROUTER_MODELS) {
    const l = limits.get(id);
    models[id] = {
      name: id,
      limit: { context: l?.context ?? 128_000, output: l?.output ?? 16_000 },
      ...(l?.images ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } : {}),
    };
  }
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "OpenRouter",
    options: { baseURL: proxyBaseUrl, apiKey: PROXY_TOKEN },
    models,
  };
}

/**
 * An OpenCode provider for the agent, calling back through the runner's proxy
 * with the proxy token, for the curated NVIDIA models in NVIDIA_MODELS. Keyed
 * only when an NVIDIA key is configured, so the agent never sees a provider it
 * cannot authenticate. Limits come from the curated catalogue; defaults otherwise.
 */
export async function nvidiaOpencodeProvider(proxyBaseUrl: string): Promise<Record<string, unknown> | null> {
  if (!NVIDIA_MODELS.length || !configured("nvidia")) return null;
  const models: Record<string, unknown> = {};
  for (const id of NVIDIA_MODELS) {
    const meta = NVIDIA_CATALOGUE[id];
    models[id] = {
      name: meta?.name ?? id,
      limit: { context: meta?.context ?? 128_000, output: meta?.output ?? 16_000 },
      ...(meta?.image ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } : {}),
    };
  }
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "NVIDIA NIM",
    options: { baseURL: proxyBaseUrl, apiKey: PROXY_TOKEN },
    models,
  };
}
