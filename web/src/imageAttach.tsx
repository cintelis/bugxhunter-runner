import { useState } from "react";
import type { ChatDoc, ChatImage } from "./types";

/** Per image, before base64; the /api/chat body limit is 32 MB after it. */
export const MAX_IMAGE = 5 * 1024 * 1024;
export const MAX_IMAGES = 4;
/** draw.io files: the render service reads up to 3 MB. */
export const MAX_DIAGRAM = 3 * 1024 * 1024 - 2048;
export const MAX_DIAGRAMS = 3;
/** For <input type="file" accept>: images, plus draw.io files (.drawio, .drawio.svg, .drawio.xml). */
export const ATTACH_ACCEPT = "image/*,.drawio,.xml,.svg";

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

const looksLikeDrawioName = (name: string) => /\.drawio(\.(svg|xml))?$/i.test(name) || /\.xml$/i.test(name);

/** Is this file a draw.io diagram? By name, or an SVG that embeds one (an export with "include a copy"). */
export async function isDrawioFile(f: File): Promise<boolean> {
  if (/\.drawio\.png$/i.test(f.name)) return false; // the diagram is in PNG metadata; not supported
  if (looksLikeDrawioName(f.name)) return true;
  if (f.type === "image/svg+xml" || /\.svg$/i.test(f.name)) {
    const head = await f.slice(0, 4096).text();
    return /content="[^"]*(mxfile|mxGraphModel)/.test(head) || /&lt;mxfile/.test(head);
  }
  return false;
}

/** A draw.io file -> its outline, from the runner's render service. */
async function readDiagram(f: File): Promise<ChatDoc> {
  const r = await fetch("/api/render/outline", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: await f.text() }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `Reading ${f.name} failed (${r.status})`);
  return { name: f.name, text: j.outline, pages: j.pages };
}

/**
 * Attachments for a Playground composer: images (pick, paste or drop) and draw.io diagrams,
 * which are turned into exact text outlines so any model, not only vision ones, can review them.
 */
export function useImageAttach() {
  const [images, setImages] = useState<ChatImage[]>([]);
  const [docs, setDocs] = useState<ChatDoc[]>([]);
  const [reading, setReading] = useState(0);
  const [attachError, setAttachError] = useState<string | null>(null);

  async function addImages(list: FileList | File[]) {
    setAttachError(null);
    const files = Array.from(list);
    const next: ChatImage[] = [];
    const diagrams: File[] = [];
    for (const f of files) {
      if (await isDrawioFile(f)) diagrams.push(f);
      else if (f.type.startsWith("image/")) {
        if (f.size > MAX_IMAGE) setAttachError(`${f.name} is over 5 MB.`);
        else next.push({ name: f.name || "pasted-image.png", url: await readAsDataUrl(f) });
      } else setAttachError(`${f.name}: attach images or draw.io files (.drawio, .drawio.svg).`);
    }
    setImages((cur) => {
      const all = [...cur, ...next];
      if (all.length > MAX_IMAGES) setAttachError(`Up to ${MAX_IMAGES} images per message.`);
      return all.slice(0, MAX_IMAGES);
    });
    for (const f of diagrams) {
      if (f.size > MAX_DIAGRAM) { setAttachError(`${f.name} is over 3 MB.`); continue; }
      setReading((n) => n + 1);
      try {
        const doc = await readDiagram(f);
        setDocs((cur) => {
          if (cur.length >= MAX_DIAGRAMS) { setAttachError(`Up to ${MAX_DIAGRAMS} diagrams per message.`); return cur; }
          return [...cur, doc];
        });
      } catch (e) {
        setAttachError(String((e as Error).message ?? e));
      } finally {
        setReading((n) => n - 1);
      }
    }
  }

  function onPaste(e: React.ClipboardEvent) {
    const pasted = Array.from(e.clipboardData.files);
    if (pasted.length) {
      e.preventDefault();
      void addImages(pasted);
    }
  }

  function onDrop(e: React.DragEvent) {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    void addImages(e.dataTransfer.files);
  }

  return {
    images,
    docs,
    /** Diagram files still being read; sending waits for them. */
    reading: reading > 0,
    attachError,
    addImages,
    onPaste,
    onDrop,
    remove: (i: number) => setImages((cur) => cur.filter((_, j) => j !== i)),
    removeDoc: (i: number) => setDocs((cur) => cur.filter((_, j) => j !== i)),
    clear: () => {
      setImages([]);
      setDocs([]);
      setAttachError(null);
    },
  };
}

export function AttachChips({ images, docs = [], onRemove, onRemoveDoc, reading }: {
  images: ChatImage[]; docs?: ChatDoc[]; onRemove: (i: number) => void; onRemoveDoc?: (i: number) => void; reading?: boolean;
}) {
  if (!images.length && !docs.length && !reading) return null;
  return (
    <div className="attach-row">
      {images.map((img, i) => (
        <span className="attach-chip" key={`i${i}`} title={img.name}>
          <img src={img.url} alt="" />
          <span className="attach-name">{img.name}</span>
          <button className="attach-x" onClick={() => onRemove(i)} aria-label={`Remove ${img.name}`}>✕</button>
        </span>
      ))}
      {docs.map((d, i) => (
        <span className="attach-chip doc" key={`d${i}`} title={`${d.name}: read as an exact outline (${d.text.length.toLocaleString()} characters${d.pages && d.pages.length > 1 ? `, ${d.pages.length} pages` : ""})`}>
          <span className="attach-doc-icon" aria-hidden>◇</span>
          <span className="attach-name">{d.name}</span>
          {onRemoveDoc && <button className="attach-x" onClick={() => onRemoveDoc(i)} aria-label={`Remove ${d.name}`}>✕</button>}
        </span>
      ))}
      {reading && <span className="attach-chip doc"><span className="attach-name">reading diagram…</span></span>}
    </div>
  );
}
