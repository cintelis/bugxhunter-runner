import type { ChatImage } from "./types";

/**
 * The wire `content` of a user turn: the plain text, or, when images are attached, the OpenAI
 * vision shape (a text part plus image_url parts). The server forwards it untouched.
 */
export function userContent(text: string | null, images?: ChatImage[]) {
  if (!images?.length) return text;
  return [
    { type: "text", text: text?.trim() || "Describe this image." },
    ...images.map((img) => ({ type: "image_url", image_url: { url: img.url } })),
  ];
}
