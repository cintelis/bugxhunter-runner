// Fitting text into canvas cards. SVG <text> doesn't wrap or clip, so a long label would run
// past the card's edge; this measures with the browser's own font metrics (a 2D canvas) and
// shortens with "…" to the width available. Without a DOM (tests) it estimates from the size.

let ctx: CanvasRenderingContext2D | null | undefined;

function measurer(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx;
  try {
    ctx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Width in px of `text` in a CSS font such as "700 14px Inter, system-ui, sans-serif". */
export function textWidth(text: string, font: string): number {
  const c = measurer();
  if (c) {
    c.font = font;
    return c.measureText(text).width;
  }
  // Estimate: average glyph width ~0.6em (monospace) / ~0.56em (sans), bold a little wider.
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 12);
  const per = /mono/i.test(font) ? 0.6 : /\b[6-9]00\b|bold/.test(font) ? 0.6 : 0.56;
  return text.length * size * per;
}

/** `text` as it fits in `maxWidth` px: whole, or cut at a character boundary with "…". */
export function fitText(text: string, maxWidth: number, font: string): string {
  if (maxWidth <= 0) return "";
  if (textWidth(text, font) <= maxWidth) return text;
  const chars = Array.from(text);
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(chars.slice(0, mid).join("").trimEnd() + "…", font) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo ? chars.slice(0, lo).join("").trimEnd() + "…" : "…";
}

export const FONT_TITLE = "700 14px Inter, system-ui, sans-serif";
export const FONT_KIND = "10px JetBrains Mono, monospace";
export const FONT_DETAIL = "11px Inter, system-ui, sans-serif";
export const FONT_FLOW = "11px JetBrains Mono, monospace";
