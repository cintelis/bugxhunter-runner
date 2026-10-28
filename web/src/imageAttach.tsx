import { useState } from "react";
import type { ChatImage } from "./types";

/** Per image, before base64; the /api/chat body limit is 32 MB after it. */
export const MAX_IMAGE = 5 * 1024 * 1024;
export const MAX_IMAGES = 4;

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Image attachments for a Playground composer: pick, paste or drop, with size and count limits. */
export function useImageAttach() {
  const [images, setImages] = useState<ChatImage[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);

  async function addImages(list: FileList | File[]) {
    setAttachError(null);
    const files = Array.from(list);
    const picked = files.filter((f) => f.type.startsWith("image/"));
    if (picked.length < files.length) setAttachError("Only images can be attached in the Playground.");
    const next: ChatImage[] = [];
    for (const f of picked) {
      if (f.size > MAX_IMAGE) {
        setAttachError(`${f.name} is over 5 MB.`);
        continue;
      }
      next.push({ name: f.name || "pasted-image.png", url: await readAsDataUrl(f) });
    }
    setImages((cur) => {
      const all = [...cur, ...next];
      if (all.length > MAX_IMAGES) setAttachError(`Up to ${MAX_IMAGES} images per message.`);
      return all.slice(0, MAX_IMAGES);
    });
  }

  function onPaste(e: React.ClipboardEvent) {
    const pasted = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
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
    attachError,
    addImages,
    onPaste,
    onDrop,
    remove: (i: number) => setImages((cur) => cur.filter((_, j) => j !== i)),
    clear: () => {
      setImages([]);
      setAttachError(null);
    },
  };
}

export function AttachChips({ images, onRemove }: { images: ChatImage[]; onRemove: (i: number) => void }) {
  if (!images.length) return null;
  return (
    <div className="attach-row">
      {images.map((img, i) => (
        <span className="attach-chip" key={i} title={img.name}>
          <img src={img.url} alt="" />
          <span className="attach-name">{img.name}</span>
          <button className="attach-x" onClick={() => onRemove(i)} aria-label={`Remove ${img.name}`}>✕</button>
        </span>
      ))}
    </div>
  );
}
