/**
 * Lightweight embeddings-backed knowledge base (RAG).
 *
 * The SCX managed `vector_stores` API is not available on this tier, but the
 * `/v1/embeddings` endpoint is — so we do retrieval ourselves: chunk documents,
 * embed each chunk via SCX, keep the vectors in memory, and rank by cosine
 * similarity at query time. Good enough for a POC knowledge base; swap the store
 * for SCX vector_stores (or pgvector) when you scale.
 */
import type { SCXClient } from "./scx.js";

const EMBED_MODEL = "E5-Mistral-7B-Instruct";

export interface KBChunk {
  text: string;
  embedding: number[];
}
export interface KBDoc {
  id: string;
  name: string;
  chunks: KBChunk[];
  chars: number;
}
export interface RetrievedChunk {
  text: string;
  score: number;
  doc: string;
}

/** Split text into overlapping chunks on paragraph/sentence-ish boundaries. */
export function chunkText(text: string, size = 900, overlap = 150): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= size) return clean ? [clean] : [];
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + size, clean.length);
    if (end < clean.length) {
      // prefer to break on a paragraph or sentence boundary near the end
      const slice = clean.slice(i, end);
      const br = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"), slice.lastIndexOf(". "));
      if (br > size * 0.5) end = i + br + 1;
    }
    chunks.push(clean.slice(i, end).trim());
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return chunks.filter(Boolean);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

let counter = 0;
const nextId = () => `doc_${(++counter).toString(36)}_${Date.now().toString(36)}`;

export class KnowledgeBase {
  private docs: KBDoc[] = [];
  constructor(private scx: SCXClient) {}

  async addDocument(name: string, text: string): Promise<KBDoc> {
    const pieces = chunkText(text);
    if (!pieces.length) throw new Error("Document is empty after chunking.");
    // E5 passages are embedded as-is; queries get a light instruction prefix.
    const res = await this.scx.embeddings({ model: EMBED_MODEL, input: pieces });
    const byIndex = [...res.data].sort((a, b) => a.index - b.index);
    const doc: KBDoc = {
      id: nextId(),
      name: name || `Document ${this.docs.length + 1}`,
      chars: text.length,
      chunks: pieces.map((t, i) => ({ text: t, embedding: byIndex[i].embedding })),
    };
    this.docs.push(doc);
    return doc;
  }

  async search(query: string, k = 4): Promise<RetrievedChunk[]> {
    if (!this.docs.length) return [];
    const q = `Instruct: Given a user question, retrieve passages that answer it\nQuery: ${query}`;
    const res = await this.scx.embeddings({ model: EMBED_MODEL, input: q });
    const qv = res.data[0].embedding;
    const scored: RetrievedChunk[] = [];
    for (const d of this.docs)
      for (const c of d.chunks) scored.push({ text: c.text, score: cosine(qv, c.embedding), doc: d.name });
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
  }

  list() {
    return this.docs.map((d) => ({ id: d.id, name: d.name, chunks: d.chunks.length, chars: d.chars }));
  }
  remove(id: string) {
    const n = this.docs.length;
    this.docs = this.docs.filter((d) => d.id !== id);
    return this.docs.length < n;
  }
  clear() {
    this.docs = [];
  }
  get size() {
    return this.docs.length;
  }
}

/** Format retrieved chunks into a system-prompt context block. */
export function buildContextBlock(chunks: RetrievedChunk[]): string {
  if (!chunks.length) return "";
  const body = chunks
    .map((c, i) => `[${i + 1}] (source: ${c.doc})\n${c.text}`)
    .join("\n\n");
  return (
    "Use the following knowledge-base excerpts to answer the user's question. " +
    "If the answer isn't contained in them, say so and answer from general knowledge. " +
    "Cite sources as [n] where relevant.\n\n===== KNOWLEDGE BASE =====\n" +
    body +
    "\n===== END KNOWLEDGE BASE ====="
  );
}
