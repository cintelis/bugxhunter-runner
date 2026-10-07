/**
 * Model providers. SCX.ai is the default; OpenRouter is optional and opens up
 * its catalogue (https://openrouter.ai/models). Both speak the OpenAI API, so
 * one client class and one key-injecting proxy serve both.
 *
 * Keys: the vault item (SCX_API, OPENROUTER_API_KEY) first, then .env, then
 * OpenCode's own auth store. They are read once here and scrubbed from the
 * environment: the OpenCode server is spawned with a copy of our environment,
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

export type ProviderId = "scx" | "openrouter";
export type KeySource = "vault" | "env" | "opencode-auth" | "none";

export interface ProviderDef {
  id: ProviderId;
  name: string;
  baseUrl: string;
  /** Vault item holding the key. */
  vaultItem: string;
  /** Environment variables that may hold it (first wins). */
  envVars: string[];
  /** Provider id in OpenCode's ~/.local/share/opencode/auth.json. */
  authId: string;
  headers?: Record<string, string>;
}

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  scx: {
    id: "scx", name: "SCX.ai", baseUrl: process.env.SCX_BASE_URL ?? "https://api.scx.ai/v1",
    vaultItem: "SCX_API", envVars: ["SCX_API", "SCX_API_KEY"], authId: "scx",
  },
  openrouter: {
    id: "openrouter", name: "OpenRouter", baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    vaultItem: "OPENROUTER_API_KEY", envVars: ["OPENROUTER_API_KEY"], authId: "openrouter",
    // Attribution headers OpenRouter asks apps to send.
    headers: { "HTTP-Referer": "https://bugxhunter.com", "X-Title": "BugXHunter" },
  },
};

/** OpenRouter ids the agent may use (OPENROUTER_MODELS=anthropic/claude-sonnet-4.5,openai/gpt-5). */
export const OPENROUTER_MODELS = (process.env.OPENROUTER_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

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
const authKeys = readAuthStore();
for (const p of Object.values(PROVIDERS)) {
  for (const v of p.envVars) if (process.env[v]) { envKeys[p.id] = process.env[v]!; break; }
  for (const v of p.envVars) delete process.env[v];
}
for (const k of ["SCX_PROXY_TOKEN", "OPEN_RUNNER_SECRET"]) delete process.env[k];

/** Where a provider's key comes from right now. */
export function keySource(id: ProviderId): KeySource {
  const p = PROVIDERS[id];
  if (vault.isInitialised() && vault.status("none").items.includes(p.vaultItem)) return "vault";
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
    case "env": return envKeys[id]!;
    case "opencode-auth": return authKeys[p.authId];
    default:
      throw httpError(503, id === "scx"
        ? "No SCX API key. Set up the vault in the sidebar, or run `opencode auth login` (provider id: scx)."
        : "No OpenRouter key. Add OPENROUTER_API_KEY to the vault (keys dialog) to use OpenRouter models.");
  }
}

export const clients: Record<ProviderId, SCXClient> = {
  scx: new SCXClient({ apiKey: () => apiKey("scx"), baseUrl: PROVIDERS.scx.baseUrl }),
  openrouter: new SCXClient({ apiKey: () => apiKey("openrouter"), baseUrl: PROVIDERS.openrouter.baseUrl, headers: PROVIDERS.openrouter.headers }),
};

/** Playground model ids: SCX ids as-is, OpenRouter ids prefixed `openrouter/`. */
export function clientFor(model: string): { client: SCXClient; model: string; provider: ProviderId } {
  if (model.startsWith("openrouter/")) return { client: clients.openrouter, model: model.slice("openrouter/".length), provider: "openrouter" };
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

/** Every model the Playground can use: SCX's, plus OpenRouter's when a key is configured. */
export async function listModels(): Promise<SCXModel[]> {
  const scx = (await clients.scx.listModels()).map((m) => ({ ...m, provider: "scx" as const }));
  if (!configured("openrouter")) return scx;
  try {
    const all = (await clients.openrouter.listModels() as unknown as OpenRouterModel[]).map(normaliseOpenRouter);
    const allow = new Set(OPENROUTER_MODELS.map((id) => `openrouter/${id}`));
    const picked = allow.size ? all.filter((m) => allow.has(m.id)) : all;
    return [...scx, ...picked.sort((a, b) => a.name.localeCompare(b.name))];
  } catch (e) {
    console.error("[openrouter] model list failed:", (e as Error).message);
    return scx;
  }
}

/**
 * An OpenCode provider for the agent, calling back through the runner's
 * proxy with the proxy token, for the models in OPENROUTER_MODELS. Context
 * and output limits come from OpenRouter when the key allows; else defaults.
 */
export async function openrouterOpencodeProvider(proxyBaseUrl: string): Promise<Record<string, unknown> | null> {
  if (!OPENROUTER_MODELS.length) return null;
  const limits = new Map<string, { context?: number | null; output?: number | null; images?: boolean }>();
  if (configured("openrouter")) {
    try {
      const all = await clients.openrouter.listModels() as unknown as OpenRouterModel[];
      for (const m of all) {
        limits.set(m.id, { context: m.context_length, output: m.top_provider?.max_completion_tokens, images: m.architecture?.input_modalities?.includes("image") });
      }
    } catch (e) {
      console.error("[openrouter] could not fetch model limits, using defaults:", (e as Error).message);
    }
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
