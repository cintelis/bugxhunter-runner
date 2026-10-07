import type { ToolDef } from "./types";

/**
 * Tool definitions carry a UI-only `id` so the editor can key each card by
 * something stable (keying by index breaks the uncontrolled schema textarea
 * when a tool in the middle of the list is removed). The id never reaches
 * the model: strip it with `stripToolIds` before sending.
 */
let seq = 0;
export const newToolId = () => `tool_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/** Give every tool an id (saved configs from before ids existed have none). */
export const withToolIds = (tools: ToolDef[]): ToolDef[] => tools.map((t) => (t.id ? t : { ...t, id: newToolId() }));

/** The wire shape: everything but the UI id. */
export const stripToolIds = (tools: ToolDef[]) => tools.map(({ id: _id, ...t }) => t);
