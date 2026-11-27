/**
 * Retired NVIDIA NIM models. NVIDIA's /v1/models keeps advertising models whose
 * endpoints now answer 404, so the Playground list would offer dead models.
 *
 * A model is marked retired when a chat to it answers 404, either from a real
 * Playground chat or from the background probe (a 1-token request to each
 * catalogue model, at most once a day). It comes back if a later probe or chat
 * succeeds. The list is not secret, so it is kept as plain JSON next to the vault.
 */
import fs from "node:fs";
import path from "node:path";
import { VAULT_FILE } from "./vault.js";

export const HEALTH_FILE =
  process.env.OPEN_RUNNER_NVIDIA_HEALTH_FILE ?? path.join(path.dirname(VAULT_FILE), "nvidia-models.json");

const PROBE_EVERY_MS = 24 * 60 * 60 * 1000;
/** Gap between probe requests, to stay well inside the free tier's rate limit. */
const PROBE_GAP_MS = Number(process.env.OPEN_RUNNER_NVIDIA_PROBE_GAP_MS ?? 1500);

interface State {
  checkedAt: string | null;
  /** Upstream id (no `nim/` prefix) → when it was first seen answering 404. */
  /** Model id to when it was found retired. A Map: the ids come from requests, and must never name a property. */
  retired: Map<string, string>;
}

let state: State | null = null;
let probing: Promise<void> | null = null;

function load(): State {
  if (state) return state;
  try {
    const s = JSON.parse(fs.readFileSync(HEALTH_FILE, "utf8")) as { checkedAt?: string | null; retired?: unknown };
    const saved = s.retired && typeof s.retired === "object" ? Object.entries(s.retired as Record<string, unknown>) : [];
    state = { checkedAt: s.checkedAt ?? null, retired: new Map(saved.map(([id, at]) => [id, String(at)])) };
  } catch {
    state = { checkedAt: null, retired: new Map() };
  }
  return state;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(HEALTH_FILE), { recursive: true });
    const tmp = `${HEALTH_FILE}.tmp`;
    const s = load();
    fs.writeFileSync(tmp, JSON.stringify({ checkedAt: s.checkedAt, retired: Object.fromEntries(s.retired) }, null, 2));
    fs.renameSync(tmp, HEALTH_FILE);
  } catch (e) {
    console.error("[nvidia] could not save model health:", (e as Error).message);
  }
}

export const isRetired = (id: string) => load().retired.has(id);
export const retiredIds = () => [...load().retired.keys()].sort();

export function markRetired(id: string) {
  const s = load();
  if (s.retired.has(id)) return;
  s.retired.set(id, new Date().toISOString());
  // The id can come from a request: quoted and escaped, so it cannot break the log line.
  console.log(`[nvidia] ${JSON.stringify(id)} answers 404, hiding it from the Playground`);
  save();
}

export function markAlive(id: string) {
  const s = load();
  if (!s.retired.delete(id)) return;
  save();
}

export function status() {
  const s = load();
  return { checkedAt: s.checkedAt, probing: Boolean(probing), retired: retiredIds() };
}

/** What a probe of one model found: 404 means retired; anything else leaves it as it is. */
export type ProbeResult = "ok" | "missing" | "unknown";

/**
 * Probe every id once if the last probe is older than a day (or `force`).
 * Runs in the background; concurrent calls share one run.
 */
export function probeIfDue(ids: string[], probeOne: (id: string) => Promise<ProbeResult>, force = false): Promise<void> {
  if (probing) return probing;
  const s = load();
  const due = force || !s.checkedAt || Date.now() - Date.parse(s.checkedAt) > PROBE_EVERY_MS;
  if (!due || !ids.length) return Promise.resolve();
  probing = (async () => {
    let gone = 0;
    for (const id of ids) {
      const r = await probeOne(id).catch((): ProbeResult => "unknown");
      if (r === "missing") { markRetired(id); gone++; }
      else if (r === "ok") markAlive(id);
      if (PROBE_GAP_MS) await new Promise((res) => setTimeout(res, PROBE_GAP_MS));
    }
    s.checkedAt = new Date().toISOString();
    save();
    console.log(`[nvidia] probed ${ids.length} models, ${gone} retired`);
  })().finally(() => { probing = null; });
  return probing;
}

/** For tests. */
export function _reset() {
  state = null;
  probing = null;
}
