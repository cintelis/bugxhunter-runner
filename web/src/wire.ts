import type { ChatDoc, ChatImage } from "./types";

/** The user's text with any attached draw.io outlines appended, as the model reads them. */
export function withDocs(text: string | null, docs?: ChatDoc[]): string | null {
  if (!docs?.length) return text;
  const blocks = docs.map((d) =>
    `Attached draw.io diagram "${d.name}", exported as an outline: its zones, the boxes inside each zone ` +
    `(legend colour meanings in [brackets]) and the arrows with their labels. Every label is exact.\n\n` +
    `<diagram file="${d.name.replace(/"/g, "'")}">\n${d.text.trimEnd()}\n</diagram>`,
  );
  return [text?.trim() || "Review this diagram for security issues.", ...blocks].join("\n\n");
}

/**
 * The wire `content` of a user turn: the plain text (plus draw.io outlines), or, when images are
 * attached, the OpenAI vision shape (a text part plus image_url parts). The server forwards it untouched.
 */
export function userContent(text: string | null, images?: ChatImage[], docs?: ChatDoc[]) {
  const t = withDocs(text, docs);
  if (!images?.length) return t;
  return [
    { type: "text", text: t?.trim() || "Describe this image." },
    ...images.map((img) => ({ type: "image_url", image_url: { url: img.url } })),
  ];
}
