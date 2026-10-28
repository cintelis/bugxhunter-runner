/**
 * Diagrams for the Playground: a diagram spec a model wrote (drawgen's YAML/JSON format)
 * becomes an editable .drawio.svg. The work happens in the separate `render` service
 * (docker/render.Dockerfile), so model output is never parsed in the process that holds
 * the vault key. Without OPEN_RUNNER_RENDER_URL (e.g. outside Docker) rendering is off
 * and the UI shows the spec as code.
 */
import { httpError } from "./errors.js";

export const RENDER_URL = (process.env.OPEN_RUNNER_RENDER_URL ?? "").replace(/\/+$/, "");
export const MAX_SPEC = 200 * 1024;

export interface DrawioResult {
  svg: string;
  xml: string;
  title: string;
  check: { errors: number; warnings: number; issues: { severity: string; code: string; cell: string; message: string }[] };
}

export const enabled = () => Boolean(RENDER_URL);

export async function status(): Promise<{ enabled: boolean; ok: boolean; drawgen?: string }> {
  if (!RENDER_URL) return { enabled: false, ok: false };
  try {
    const r = await fetch(`${RENDER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    const j = (await r.json()) as { drawgen?: string };
    return { enabled: true, ok: r.ok, drawgen: j.drawgen };
  } catch {
    return { enabled: true, ok: false };
  }
}

/** Render one spec. Spec mistakes come back as 422 with drawgen's message (for the model to fix). */
export async function drawio(spec: unknown): Promise<DrawioResult> {
  if (!RENDER_URL) throw httpError(503, "Diagram rendering is off: it needs the render service (part of the Docker setup).");
  if (typeof spec !== "string" && (typeof spec !== "object" || spec === null || Array.isArray(spec))) {
    throw httpError(400, "spec must be YAML/JSON text or an object");
  }
  const body = JSON.stringify({ spec });
  if (Buffer.byteLength(body) > MAX_SPEC) throw httpError(413, `The diagram spec is over ${MAX_SPEC / 1024} KB.`);
  let r: Response;
  try {
    r = await fetch(`${RENDER_URL}/drawio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw httpError(503, "The render service is not answering.");
  }
  const j = (await r.json().catch(() => ({}))) as Partial<DrawioResult> & { error?: { message?: string } };
  if (!r.ok || !j.svg) throw httpError(r.status === 200 ? 502 : r.status, j.error?.message || `Rendering failed (${r.status}).`);
  return j as DrawioResult;
}

export const MAX_DIAGRAM_FILE = 3 * 1024 * 1024 - 1024;

/** A .drawio / .drawio.svg file a person attached -> the outline a model reviews. */
export async function outline(file: unknown): Promise<{ outline: string; pages: string[]; chars: number }> {
  if (!RENDER_URL) throw httpError(503, "Reading draw.io files needs the render service (part of the Docker setup).");
  if (typeof file !== "string" || !file.trim()) throw httpError(400, "file must be the text of a .drawio or .drawio.svg file");
  const body = JSON.stringify({ file });
  if (Buffer.byteLength(body) > MAX_DIAGRAM_FILE) throw httpError(413, "The diagram file is over 3 MB.");
  let r: Response;
  try {
    r = await fetch(`${RENDER_URL}/drawio/outline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw httpError(503, "The render service is not answering.");
  }
  const j = (await r.json().catch(() => ({}))) as { outline?: string; pages?: string[]; chars?: number; error?: { message?: string } };
  if (!r.ok || typeof j.outline !== "string") throw httpError(r.status === 200 ? 502 : r.status, j.error?.message || `Reading the diagram failed (${r.status}).`);
  return { outline: j.outline, pages: j.pages ?? [], chars: j.chars ?? j.outline.length };
}
