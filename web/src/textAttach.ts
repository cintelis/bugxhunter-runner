// Text files a Playground composer accepts as attachments: Markdown and plain text, sent to
// the model as they are, so any model can read them (no vision needed).

/** Per file. A threat model, a design note or a log excerpt fits; a whole dump does not. */
export const MAX_TEXT_FILE = 512 * 1024;
export const MAX_TEXT_FILES = 5;
/** For <input type="file" accept>. */
export const TEXT_ACCEPT = ".md,.markdown,.txt,text/markdown,text/plain";

/** Is this a Markdown or plain-text file? By extension first: browsers often give .md no type. */
export function isTextFile(name: string, type = ""): boolean {
  if (/\.(md|markdown|txt)$/i.test(name)) return true;
  return type === "text/markdown" || type === "text/plain";
}

/** Whether what was read is not text after all (a binary file renamed .txt): it has control characters. */
export function looksBinary(text: string): boolean {
  return /[\u0000-\u0008\u000E-\u001A]/.test(text.slice(0, 8192));
}
