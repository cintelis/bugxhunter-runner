/**
 * Audit log: one JSON line per event, one file per day, e.g.
 *   /workspace/logs/2026-10-06.jsonl
 *
 * Records what the agent was asked and what it did: prompts and commands,
 * completed tool calls (inputs + truncated output), permission and question
 * requests and answers, internet-access decisions, and errors. Fed by our own
 * routes plus a subscription to OpenCode's all-projects event stream, so it
 * captures activity even when no browser is open.
 *
 * Note: in Docker this folder is inside the agent's workspace, so the agent
 * could edit it. It is a working log, not tamper-proof evidence.
 */
import fs from "node:fs";
import path from "node:path";

export const LOG_DIR = process.env.OPEN_RUNNER_LOG_DIR ?? "";

let ready = false;
function ensureDir() {
  if (ready || !LOG_DIR) return ready;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // Keep logs out of git status / the Changes view.
    const ignore = path.join(LOG_DIR, ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
    ready = true;
  } catch (e) {
    console.error("[audit] cannot create log folder:", (e as Error).message);
  }
  return ready;
}

export function audit(event: string, data: Record<string, unknown> = {}) {
  if (!ensureDir()) return;
  const now = new Date();
  const line = JSON.stringify({ ts: now.toISOString(), event, ...data }) + "\n";
  fs.appendFile(path.join(LOG_DIR, `${now.toISOString().slice(0, 10)}.jsonl`), line, (err) => {
    if (err) console.error("[audit] write failed:", err.message);
  });
}

const clip = (v: unknown, n = 4000) => (typeof v === "string" && v.length > n ? v.slice(0, n) + `… (${v.length} chars)` : v);

/** Follow OpenCode's global event stream and log the events that matter. */
export function followOpencode(url: string) {
  if (!LOG_DIR) return;
  const seenTools = new Set<string>();
  const run = async () => {
    while (true) {
      try {
        const r = await fetch(`${url}/global/event`);
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        const dec = new TextDecoder();
        let buf = "";
        for await (const chunk of r.body as any) {
          buf += dec.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            try {
              const { directory, payload } = JSON.parse(line.slice(5));
              record(directory, payload, seenTools);
            } catch { /* partial / non-JSON */ }
          }
        }
      } catch { /* reconnect */ }
      await new Promise((res) => setTimeout(res, 3000));
    }
  };
  run();
}

function record(directory: string | undefined, evt: any, seenTools: Set<string>) {
  const p = evt?.properties ?? {};
  switch (evt?.type) {
    case "message.part.updated": {
      const part = p.part;
      if (part?.type !== "tool") return;
      const st = part.state ?? {};
      if (st.status !== "completed" && st.status !== "error") return;
      const key = `${part.callID}:${st.status}`;
      if (seenTools.has(key)) return;
      seenTools.add(key);
      if (seenTools.size > 5000) seenTools.clear();
      audit("tool", {
        directory, session: part.sessionID, tool: part.tool, status: st.status,
        input: st.input, output: clip(st.output), error: st.error,
      });
      return;
    }
    case "permission.asked":
    case "permission.updated":
      audit("permission.asked", { directory, session: p.sessionID, id: p.id, type: p.type ?? p.permission, pattern: p.pattern ?? p.patterns, title: p.title });
      return;
    case "permission.replied":
      audit("permission.replied", { directory, session: p.sessionID, id: p.permissionID ?? p.requestID, response: p.response ?? p.reply });
      return;
    case "question.asked":
      audit("question.asked", { directory, session: p.sessionID, id: p.id, questions: p.questions });
      return;
    case "question.replied":
      audit("question.replied", { directory, session: p.sessionID, id: p.requestID, answers: p.answers });
      return;
    case "question.rejected":
      audit("question.dismissed", { directory, session: p.sessionID, id: p.requestID });
      return;
    case "session.error":
      audit("error", { directory, session: p.sessionID, error: p.error });
      return;
  }
}
