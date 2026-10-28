/**
 * Saved Playground sessions (chats and threat-model canvases), encrypted with the vault key.
 *
 * One file per session next to the vault: /data/playground in Docker (the runner-only
 * runner-data volume, never the agent's), ~/.config/bugxhunter/playground otherwise. Only ids,
 * kind and timestamps are in the clear; the title and the body are sealed separately (the title
 * so a listing doesn't decrypt every body), each bound to its record by its AAD. A copied
 * volume or a stolen disk shows how many sessions exist and when, nothing about what is in them.
 */
import fs from "node:fs";
import path from "node:path";
import type { Sealed } from "../../shared/vault.js";
import { VAULT_FILE, openData, sealData } from "./vault.js";
import { httpError } from "./errors.js";
import { audit } from "./audit.js";

export const PLAYGROUND_DIR = process.env.OPEN_RUNNER_PLAYGROUND_DIR ?? path.join(path.dirname(VAULT_FILE), "playground");

export type SessionKind = "chat" | "canvas";
const KINDS: SessionKind[] = ["chat", "canvas"];
const ID = /^[a-z0-9][a-z0-9-]{7,63}$/;
/** Sealed body cap: four 5 MB images in base64 plus the transcript fit well under it. */
const MAX_BODY = 36 * 1024 * 1024;
const MAX_SESSIONS = 500;

interface SessionFile {
  v: 1;
  id: string;
  kind: SessionKind;
  createdAt: string;
  updatedAt: string;
  title: Sealed;
  body: Sealed;
}

export interface SessionSummary {
  id: string;
  kind: SessionKind;
  title: string;
  createdAt: string;
  updatedAt: string;
  bytes: number;
}

function check(kind: string, id?: string): asserts kind is SessionKind {
  if (!KINDS.includes(kind as SessionKind)) throw httpError(400, "Unknown session kind.");
  if (id !== undefined && !ID.test(id)) throw httpError(400, "Malformed session id.");
}

const file = (kind: SessionKind, id: string) => path.join(PLAYGROUND_DIR, `${kind}-${id}.json`);
const aad = (kind: SessionKind, id: string, part: "title" | "body") => `playground:${kind}:${id}:${part}`;

function read(kind: SessionKind, id: string): SessionFile | null {
  try {
    const r = JSON.parse(fs.readFileSync(file(kind, id), "utf8")) as SessionFile;
    return r?.v === 1 && r.id === id && r.kind === kind ? r : null;
  } catch {
    return null;
  }
}

export function list(kind: SessionKind): SessionSummary[] {
  check(kind);
  let names: string[];
  try {
    names = fs.readdirSync(PLAYGROUND_DIR);
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const name of names) {
    const m = name.match(/^(chat|canvas)-([a-z0-9-]+)\.json$/);
    if (!m || m[1] !== kind) continue;
    const r = read(kind, m[2]);
    if (!r) continue;
    let title: string;
    try {
      title = openData(r.title, aad(kind, r.id, "title"));
    } catch (e) {
      if ((e as { status?: number }).status === 503) throw e; // sealed: say so rather than list nothing
      continue; // a record that won't open (other vault, tampered) is skipped, not fatal
    }
    out.push({ id: r.id, kind, title, createdAt: r.createdAt, updatedAt: r.updatedAt, bytes: r.body.ct.length });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function get(kind: SessionKind, id: string): { id: string; kind: SessionKind; title: string; updatedAt: string; body: unknown } {
  check(kind, id);
  const r = read(kind, id);
  if (!r) throw httpError(404, "No such saved session.");
  try {
    return {
      id, kind,
      title: openData(r.title, aad(kind, id, "title")),
      updatedAt: r.updatedAt,
      body: JSON.parse(openData(r.body, aad(kind, id, "body"))),
    };
  } catch (e) {
    if ((e as { status?: number }).status) throw e;
    throw httpError(422, "This saved session does not open with the current vault.");
  }
}

export function put(kind: SessionKind, id: string, title: string, body: unknown): { updatedAt: string } {
  check(kind, id);
  const json = JSON.stringify(body ?? null);
  if (json.length > MAX_BODY) throw httpError(413, "Session too large to save (images count towards it).");
  const prev = read(kind, id);
  if (!prev) {
    let count = 0;
    try { count = fs.readdirSync(PLAYGROUND_DIR).filter((n) => n.endsWith(".json")).length; } catch { /* no dir yet */ }
    if (count >= MAX_SESSIONS) throw httpError(409, `Up to ${MAX_SESSIONS} saved sessions; delete some first.`);
  }
  const now = new Date().toISOString();
  const record: SessionFile = {
    v: 1, id, kind,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    title: sealData(String(title || "Untitled").slice(0, 200), aad(kind, id, "title")),
    body: sealData(json, aad(kind, id, "body")),
  };
  fs.mkdirSync(PLAYGROUND_DIR, { recursive: true, mode: 0o700 });
  const target = file(kind, id);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, target);
  if (!prev) audit("playground.saved", { kind, id });
  return { updatedAt: now };
}

export function remove(kind: SessionKind, id: string) {
  check(kind, id);
  fs.rmSync(file(kind, id), { force: true });
  audit("playground.deleted", { kind, id });
}

export function removeAll(kind: SessionKind): number {
  check(kind);
  let n = 0;
  let names: string[] = [];
  try { names = fs.readdirSync(PLAYGROUND_DIR); } catch { return 0; }
  for (const name of names) {
    if (name.startsWith(`${kind}-`) && name.endsWith(".json")) {
      fs.rmSync(path.join(PLAYGROUND_DIR, name), { force: true });
      n++;
    }
  }
  audit("playground.deleted_all", { kind, count: n });
  return n;
}
