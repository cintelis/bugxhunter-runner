/**
 * Saved Playground sessions (server routes under /api/playground/sessions). The runner seals
 * each one with the vault key into its own data volume; nothing is kept in browser storage.
 */

export type SessionKind = "chat" | "canvas";

export interface SavedSession {
  id: string;
  kind: SessionKind;
  title: string;
  createdAt: string;
  updatedAt: string;
  bytes: number;
}

/** A fresh id the server accepts ([a-z0-9-], 8–64 chars). */
export const newSessionId = () => crypto.randomUUID().toLowerCase();

const base = (kind: SessionKind) => `/api/playground/sessions/${kind}`;

async function ok<T>(r: Response, what: string): Promise<T> {
  if (r.ok) return r.json();
  let msg = "";
  try { msg = (await r.json())?.error?.message ?? ""; } catch { /* not JSON */ }
  throw new Error(msg || `${what} failed (${r.status})`);
}

export const listSessions = (kind: SessionKind) =>
  fetch(base(kind)).then((r) => ok<{ sessions: SavedSession[] }>(r, "Listing saved sessions")).then((j) => j.sessions);

export const loadSession = <T>(kind: SessionKind, id: string) =>
  fetch(`${base(kind)}/${id}`).then((r) => ok<{ id: string; title: string; updatedAt: string; body: T }>(r, "Opening the session"));

export const saveSession = (kind: SessionKind, id: string, title: string, body: unknown) =>
  fetch(`${base(kind)}/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body }),
  }).then((r) => ok<{ updatedAt: string }>(r, "Saving"));

export const deleteSession = (kind: SessionKind, id: string) =>
  fetch(`${base(kind)}/${id}`, { method: "DELETE" }).then((r) => ok<{ ok: true }>(r, "Deleting"));
