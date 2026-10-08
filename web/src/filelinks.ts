/**
 * File paths in the agent's prose become download links.
 *
 * "Saved as /workspace/acme/app/analysis.md" is how the agent reports a file
 * it wrote, and in Docker that folder is a volume Finder cannot open. So any
 * absolute path under one of the known roots (the project folder; /workspace
 * in Docker) that looks like a file becomes a link to /api/agent/file, which
 * streams it as a download after checking it really is inside the project.
 *
 * Runs on the sanitised HTML string: text between tags is scanned, text
 * already inside an <a> is left alone, and the inserted anchors carry only a
 * same-origin href and `download`, so nothing from the model reaches them.
 */

let roots: string[] = [];
let directory = "";

/** The project folder (what the download route checks against) and any extra roots to recognise. */
export function setFileRoots(projectDirectory: string, extra: string[] = []) {
  directory = projectDirectory;
  roots = [projectDirectory, ...extra].filter(Boolean);
}
/** The current roots and project folder (stable references until setFileRoots runs again). */
export const fileRoots = () => roots;
export const fileDirectory = () => directory;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Download URL for a file in the current project. */
export function fileUrl(path: string, dir = directory): string {
  return `/api/agent/file?directory=${encodeURIComponent(dir)}&path=${encodeURIComponent(path)}`;
}

/**
 * A path under a root, continuing through path characters, ending in what
 * looks like a file name (an extension), not swallowing trailing punctuation.
 */
function pathPattern(rootList: string[]): RegExp | null {
  if (!rootList.length) return null;
  const alts = rootList.map((r) => escapeRe(r.replace(/[\\/]+$/, "")).replace(/\\\\|\//g, "[\\\\/]")).join("|");
  return new RegExp(`(?:${alts})(?:[\\\\/][^\\s"'<>\`()\\[\\]{}|]*?)+?\\.[A-Za-z0-9]{1,8}(?=[\\s"'<>\`()\\[\\]{}|.,;:!?]|$)`, "g");
}

/** Replace file paths in the text parts of `html` with download anchors. */
export function linkFilePaths(html: string, rootList: string[] = roots, dir = directory): string {
  const re = pathPattern(rootList);
  if (!re) return html;
  let inAnchor = 0;
  return html.split(/(<[^>]+>)/).map((piece) => {
    if (piece.startsWith("<")) {
      if (/^<a[\s>]/i.test(piece)) inAnchor++;
      else if (/^<\/a>/i.test(piece)) inAnchor = Math.max(0, inAnchor - 1);
      return piece;
    }
    if (inAnchor || !piece) return piece;
    return piece.replace(re, (m) => `<a class="file-link" href="${fileUrl(unescapeEntities(m), dir)}" download title="Download ${escapeHtml(m)}">${m}</a>`);
  }).join("");
}

/** The text was HTML-escaped by the renderer; the href wants the real path. */
function unescapeEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
