/**
 * Diagram blocks in model replies: a fenced block tagged `drawio` holds a drawgen spec
 * (YAML or JSON) that the runner's render service turns into an editable .drawio.svg.
 * Everything else stays markdown.
 */

export type Part =
  | { type: "md"; text: string }
  /** `closed` is false while the reply is still streaming the block. */
  | { type: "drawio"; spec: string; closed: boolean };

const OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*(?:drawio|drawgen)\b[^\n]*$/i;

/** Split a reply into markdown and diagram parts, in order. */
export function splitDiagrams(text: string): Part[] {
  const lines = text.split("\n");
  const parts: Part[] = [];
  let md: string[] = [];
  const flush = () => {
    if (md.join("\n").trim()) parts.push({ type: "md", text: md.join("\n") });
    md = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(OPEN);
    if (!m) { md.push(lines[i]); continue; }
    const fence = m[1];
    const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) body.push(lines[j++]);
    flush();
    parts.push({ type: "drawio", spec: body.join("\n"), closed: j < lines.length });
    i = j;
  }
  flush();
  return parts;
}

export interface CheckIssue { severity: string; code: string; cell: string; message: string }

/** The message that asks the model to fix its diagram, from a spec error or the checker's issues. */
export function fixRequest(error: string | null, issues: CheckIssue[]): string {
  const list = error
    ? error.split("\n").filter(Boolean)
    : issues.map((i) => `${i.severity} ${i.code} ${i.cell}: ${i.message}`);
  return [
    "The diagram renderer reported these problems with your drawio spec:",
    ...list.slice(0, 30).map((l) => `- ${l}`),
    "",
    "Reply with the corrected spec in a single ```drawio block.",
  ].join("\n");
}

/** A file name from a diagram title. */
export const diagramFileName = (title: string) =>
  (title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "diagram");
