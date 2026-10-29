/**
 * Flag highlighting for CTFs and labs.
 *
 * A flag is easy to miss in a tool dump, so anything matching the flag format is wrapped in a
 * <mark>. The format is a regular expression the person sets in the sidebar (kept in
 * localStorage, this browser only); the default matches the common shapes: flag{...},
 * CTF{...}, picoCTF{...}, HTB{...} and any short upper-case or lower-case prefix before braces.
 *
 * Two entry points: `markFlags` works on the sanitised HTML string the way filelinks.ts does
 * (only text between tags is scanned, so markup from the model never reaches the regex), and
 * `flagFragments` splits plain text for <pre> blocks rendered by React.
 */

export const FLAG_KEY = "or_flag_pattern";
export const DEFAULT_FLAG_PATTERN = "\\b[A-Za-z][A-Za-z0-9_-]{1,15}\\{[^{}\\s]{3,120}\\}";

let pattern = DEFAULT_FLAG_PATTERN;
try {
  pattern = localStorage.getItem(FLAG_KEY) || DEFAULT_FLAG_PATTERN;
} catch { /* no storage: the default */ }

export const flagPattern = () => pattern;

/** Set the pattern; an invalid or empty one falls back to the default. Returns what is in force. */
export function setFlagPattern(next: string): string {
  const trimmed = next.trim();
  pattern = trimmed && isValid(trimmed) ? trimmed : DEFAULT_FLAG_PATTERN;
  try {
    if (trimmed) localStorage.setItem(FLAG_KEY, trimmed);
    else localStorage.removeItem(FLAG_KEY);
  } catch { /* not essential */ }
  return pattern;
}

export function isValid(re: string): boolean {
  try {
    new RegExp(re, "g");
    return true;
  } catch {
    return false;
  }
}

const compile = (re = pattern) => new RegExp(re, "g");

/** Wrap every flag in the text parts of sanitised `html` in <mark class="flag">. */
export function markFlags(html: string, re = pattern): string {
  if (re === DEFAULT_FLAG_PATTERN && !html.includes("{")) return html;
  const rx = compile(re);
  return html.split(/(<[^>]+>)/).map((piece) => {
    if (piece.startsWith("<") || !piece) return piece;
    return piece.replace(rx, (m) => `<mark class="flag">${m}</mark>`);
  }).join("");
}

/** Plain text split into alternating [text, flag, text, flag, ...] pieces; odd indexes are flags. */
export function flagFragments(text: string, re = pattern): string[] {
  if (re === DEFAULT_FLAG_PATTERN && !text.includes("{")) return [text];
  const rx = compile(re);
  const out: string[] = [];
  let last = 0;
  for (const m of text.matchAll(rx)) {
    const at = m.index ?? 0;
    if (!m[0]) continue;
    out.push(text.slice(last, at), m[0]);
    last = at + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}
