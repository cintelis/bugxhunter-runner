import { useEffect, useMemo, useState } from "react";
import { Markdown } from "./Markdown";
import { diagramFileName, fixRequest, splitDiagrams, type CheckIssue } from "./diagrams";

interface Rendered {
  svg: string;
  xml: string;
  title: string;
  check: { errors: number; warnings: number; issues: CheckIssue[] };
}
type Outcome = { ok: true; r: Rendered } | { ok: false; error: string };

// One render per distinct spec, shared across re-renders and reopened chats.
const cache = new Map<string, Promise<Outcome>>();
let statusP: Promise<boolean> | null = null;

export const renderAvailable = () =>
  (statusP ??= fetch("/api/render/status").then((r) => r.json()).then((j) => Boolean(j?.ok)).catch(() => false));

export function renderDrawio(spec: string | object): Promise<Outcome> {
  const key = typeof spec === "string" ? spec : JSON.stringify(spec);
  let p = cache.get(key);
  if (!p) {
    p = fetch("/api/render/drawio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        return r.ok ? { ok: true as const, r: j as Rendered } : { ok: false as const, error: j?.error?.message || `Rendering failed (${r.status})` };
      })
      .catch((e) => ({ ok: false as const, error: String(e?.message ?? e) }));
    cache.set(key, p);
    if (cache.size > 60) cache.delete(cache.keys().next().value!);
  }
  return p;
}

export function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** An assistant reply: markdown, with ```drawio blocks drawn as diagrams. */
export function RichReply({ text, streaming, onFix }: { text: string; streaming: boolean; onFix?: (msg: string) => void }) {
  const parts = useMemo(() => splitDiagrams(text), [text]);
  if (parts.length === 1 && parts[0].type === "md") return <Markdown text={text} />;
  return (
    <>
      {parts.map((p, i) =>
        p.type === "md"
          ? <Markdown key={i} text={p.text} />
          : <DrawioBlock key={i} spec={p.spec} pending={!p.closed && streaming} onFix={onFix} />,
      )}
    </>
  );
}

export function DrawioBlock({ spec, pending, onFix }: { spec: string; pending: boolean; onFix?: (msg: string) => void }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [out, setOut] = useState<Outcome | null>(null);
  const [showSpec, setShowSpec] = useState(false);

  useEffect(() => { renderAvailable().then(setAvailable); }, []);
  useEffect(() => {
    if (pending || !available || !spec.trim()) return;
    let live = true;
    setOut(null);
    renderDrawio(spec).then((o) => live && setOut(o));
    return () => { live = false; };
  }, [spec, pending, available]);

  const url = useMemo(() => (out?.ok ? URL.createObjectURL(new Blob([out.r.svg], { type: "image/svg+xml" })) : null), [out]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  const code = <pre className="diagram-spec"><code>{spec}</code></pre>;
  if (pending) return <div className="diagram-card"><div className="diagram-head"><span className="diagram-tag">drawio</span> drawing…</div>{code}</div>;
  if (available === false) {
    return (
      <div className="diagram-card">
        <div className="diagram-head"><span className="diagram-tag">drawio</span> Diagram rendering needs the render service (Docker setup).</div>
        {code}
      </div>
    );
  }
  if (!out) return <div className="diagram-card"><div className="diagram-head"><span className="diagram-tag">drawio</span> rendering…</div></div>;

  const issues = out.ok ? out.r.check.issues : [];
  const name = out.ok ? diagramFileName(out.r.title) : "diagram";
  return (
    <div className="diagram-card">
      <div className="diagram-head">
        <span className="diagram-tag">drawio</span>
        <span className="diagram-title">{out.ok ? out.r.title : "Diagram spec has problems"}</span>
        {out.ok && (issues.length
          ? <span className="diagram-warn" title={issues.map((i) => `${i.severity} ${i.code} ${i.cell}: ${i.message}`).join("\n")}>{issues.length} layout issue{issues.length === 1 ? "" : "s"}</span>
          : <span className="diagram-ok">checked</span>)}
        <span className="spacer" />
        {out.ok && <button className="btn ghost sm" onClick={() => download(`${name}.drawio.svg`, out.r.svg, "image/svg+xml")} title="An SVG with the diagram embedded: opens for editing in draw.io and its VS Code extension">.drawio.svg</button>}
        {out.ok && <button className="btn ghost sm" onClick={() => download(`${name}.drawio`, out.r.xml, "application/xml")}>.drawio</button>}
        <button className="btn ghost sm" onClick={() => setShowSpec((v) => !v)}>{showSpec ? "hide spec" : "spec"}</button>
        {onFix && (!out.ok || issues.length > 0) && (
          <button className="btn sm" onClick={() => onFix(fixRequest(out.ok ? null : out.error, issues))} title="Send the problems back to the model">ask model to fix</button>
        )}
      </div>
      {out.ok
        ? <img className="diagram-img" src={url!} alt={out.r.title} />
        : <pre className="diagram-error">{out.error}</pre>}
      {showSpec && code}
    </div>
  );
}
