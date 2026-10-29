import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { fileDirectory, fileRoots, linkFilePaths } from "./filelinks";
import { flagPattern, markFlags } from "./flags";

marked.setOptions({ gfm: true, breaks: false });
const NONE: string[] = [];

// Open links from model output in a new tab, never in the app's own tab.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Render model markdown as sanitised HTML. */
export function Markdown({ text, className = "", files = false }: { text: string; className?: string; files?: boolean }) {
  // `files`: paths inside the project become download links (agent output only).
  const roots = files ? fileRoots() : NONE;
  const dir = files ? fileDirectory() : "";
  const flags = flagPattern();
  const html = useMemo(() => {
    const clean = DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
    // Flags (CTFs, labs) are marked after sanitising and linking: both scan text outside tags only.
    return markFlags(files ? linkFilePaths(clean, roots, dir) : clean, flags);
  }, [text, files, roots, dir, flags]);
  return <div className={"md " + className} dangerouslySetInnerHTML={{ __html: html }} />;
}
