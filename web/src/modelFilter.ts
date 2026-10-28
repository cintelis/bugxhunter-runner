import type { SCXModel } from "./types";

// The live NVIDIA catalogue (and SCX) lists models that cannot hold a chat: embedders,
// rerankers, guard/safety classifiers, detectors, speech-to-text and the like. Picking one in
// the Playground just errors upstream, so the dropdown hides them unless asked. Matched against
// the id and name; it is a heuristic, which is why "show all models" stays one click away.
const NON_CHAT = /(embed|rerank|retriev|guard|safety|detector|deplot|calibration|reward|whisper|\bstt\b|\btts\b|parse|ocr|opir)/i;

/** True if the model looks like it can answer a chat completion. */
export function isChatModel(m: Pick<SCXModel, "id" | "name" | "output_modalities">): boolean {
  if (!m.output_modalities.includes("text")) return false;
  return !NON_CHAT.test(`${m.id} ${m.name}`);
}

/** Case-insensitive match on name or id; an empty query matches everything. */
export function matchesQuery(m: Pick<SCXModel, "id" | "name">, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || `${m.name} ${m.id}`.toLowerCase().includes(q);
}
