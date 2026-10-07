/**
 * Prompt attachments.
 *
 * Every attached file is saved into `<project>/attachments/` so the agent's
 * tools can work with it. On top of that:
 *  - images go to the model inline (data URL) — for models that accept images;
 *  - small text files are passed as file:// parts, which OpenCode reads into
 *    the prompt;
 *  - anything else (PDFs, archives, …) is just mentioned by path.
 *
 * In Docker the runner mounts the same workspace volume as the agent, so the
 * paths are identical in both containers.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface Attachment {
  name: string;
  mime: string;
  /** Base64 file contents (no data: prefix). */
  data: string;
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const INLINE_TEXT_BYTES = 512 * 1024;
const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|ya?ml|toml|ini|cfg|conf|csv|tsv|log|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|sql|env|gitignore|dockerfile|tf|gradle|swift|lua|r|pl)$/i;

const isText = (name: string, mime: string) =>
  mime.startsWith("text/") || /json|xml|yaml|javascript|typescript|x-sh|x-python|sql/.test(mime) || TEXT_EXT.test(name);

/** A file name that is safe to create inside the project: basename only, no odd characters. */
export function safeName(name: string) {
  // Last segment after either separator style: the browser may be on Windows
  // while this server runs on Linux, where path.basename ignores backslashes.
  const last = name.split(/[\\/]/).pop() ?? "";
  const base = last.replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "").slice(0, 120);
  return base || "file";
}

function uniquePath(dir: string, name: string) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem}-${i}${ext}`);
  return candidate;
}

export interface SavedAttachments {
  /** OpenCode prompt parts (file parts) to send along with the text. */
  parts: Record<string, unknown>[];
  /** A note for the prompt telling the agent where the files are. */
  note: string;
  saved: { name: string; path: string; bytes: number; mime: string }[];
}

export function saveAttachments(directory: string, files: Attachment[], inlineImages = true): SavedAttachments {
  const dir = path.join(directory, "attachments");
  fs.mkdirSync(dir, { recursive: true });
  const parts: Record<string, unknown>[] = [];
  const saved: SavedAttachments["saved"] = [];

  for (const f of files) {
    const bytes = Buffer.from(f.data ?? "", "base64");
    if (bytes.length > MAX_FILE_BYTES) {
      throw Object.assign(new Error(`${f.name} is larger than 25 MB`), { status: 413 });
    }
    const name = safeName(f.name);
    const mime = f.mime || "application/octet-stream";
    const abs = uniquePath(dir, name);
    fs.writeFileSync(abs, bytes);
    const rel = path.relative(directory, abs).split(path.sep).join("/");
    saved.push({ name: path.basename(abs), path: rel, bytes: bytes.length, mime });

    if (mime.startsWith("image/")) {
      if (!inlineImages) continue; // model can't see images: it gets the saved path only
      parts.push({ type: "file", mime, filename: path.basename(abs), url: `data:${mime};base64,${f.data}` });
    } else if (isText(name, mime) && bytes.length <= INLINE_TEXT_BYTES) {
      parts.push({ type: "file", mime: "text/plain", filename: path.basename(abs), url: pathToFileURL(abs).href });
    }
  }

  const note = saved.length
    ? `\n\n[Attached file${saved.length > 1 ? "s" : ""}, saved in the project: ${saved.map((s) => s.path).join(", ")}]`
    : "";
  return { parts, note, saved };
}
