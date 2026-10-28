import { useEffect, useMemo, useRef, useState } from "react";
import { runChat } from "./api";
import type { BotConfig, SCXModel } from "./types";
import { TerminalBar } from "./Terminal";
import { PaperclipIcon } from "./icons";
import { isChatModel } from "./modelFilter";
import { userContent } from "./wire";
import { ATTACH_ACCEPT, AttachChips, useImageAttach } from "./imageAttach";
import { renderAvailable, renderDrawio } from "./DrawioBlock";
import {
  NODE_H, NODE_W, buildBudget, empty, extractJson, findingsMarkdown, layout, normalize, stats, toDrawioSpec, worstOpen,
  type Finding, type FindingStatus, type NodeKind, type Severity, type TMNode, type ThreatModel,
} from "./canvas/model";
import { CANVAS_SYSTEM, canvasUserPrompt } from "./canvas/prompt";
import { deleteSession, listSessions, loadSession, newSessionId, saveSession, type SavedSession } from "./sessionsApi";

// Threat-model canvas: build a map of a system from a diagram or a description, then work it:
// mark scope and coverage, track findings to fixed, export the model and a findings table.
// Colours are inline SVG attributes rather than CSS classes so an exported SVG looks the same.
// Canvases are saved on the runner, sealed with the vault key (see sessionsApi.ts); the
// browser keeps nothing. Each build or import starts a new saved canvas; edits auto-save.

/** Where the first prototype kept the canvas in plain browser storage; migrated once, then removed. */
const LEGACY_KEY = "or_threat_model";
const SAVE_DELAY = 1200;

/** The visible window onto the canvas, in SVG units. */
interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

const KIND_COLOR: Record<NodeKind, string> = { actor: "#00e5ff", service: "#8fa8ff", datastore: "#ffb300", external: "#b4bcc6" };
const SEV_COLOR: Record<Severity, string> = { critical: "#ff3c3c", high: "#ff7a45", medium: "#ffb300", low: "#6e7681" };
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const KINDS: NodeKind[] = ["actor", "service", "datastore", "external"];

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

interface Props {
  config: BotConfig;
  models: SCXModel[];
  onExit: () => void;
}

export function Canvas({ config, models, onExit }: Props) {
  const [model, setModel] = useState<ThreatModel>(empty);
  const [canvasId, setCanvasId] = useState<string>(newSessionId);
  const [undo, setUndo] = useState<{ model: ThreatModel; id: string } | null>(null);
  const [saved, setSaved] = useState<SavedSession[]>([]);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const lastSavedJson = useRef("");
  const [selected, setSelected] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const att = useImageAttach();
  const fileRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refreshSaved = () =>
    listSessions("canvas").then(setSaved).catch((e) => setSaveMsg({ ok: false, text: String(e.message ?? e) }));

  /** Show a model under an id, marking it as already saved so opening it doesn't re-save it. */
  function show(next: ThreatModel, id: string, alreadySaved: boolean) {
    setModel(next);
    setCanvasId(id);
    setSelected(null);
    setView(null);
    lastSavedJson.current = alreadySaved ? JSON.stringify(next) : "";
  }

  // First open: move any canvas the prototype left in plain browser storage into the sealed
  // store (and delete the plain copy once it is safely saved), then open the latest canvas.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        let legacy: string | null = null;
        try { legacy = localStorage.getItem(LEGACY_KEY); } catch { /* storage blocked */ }
        if (legacy) {
          const m = layout(normalize(JSON.parse(legacy)));
          if (m.nodes.length) await saveSession("canvas", newSessionId(), m.title, m);
          try { localStorage.removeItem(LEGACY_KEY); } catch { /* storage blocked */ }
        }
        const list = await listSessions("canvas");
        if (!live) return;
        setSaved(list);
        if (list[0]) {
          const s = await loadSession<unknown>("canvas", list[0].id);
          if (live) show(layout(normalize(s.body)), list[0].id, true);
        }
      } catch (e) {
        if (live) setSaveMsg({ ok: false, text: `Saved canvases unavailable: ${String((e as Error).message ?? e)}` });
      } finally {
        if (live) setLoaded(true);
      }
    })();
    return () => { live = false; };
  }, []);

  // Auto-save edits (debounced). Empty canvases aren't saved.
  useEffect(() => {
    if (!loaded || !model.nodes.length) return;
    const json = JSON.stringify(model);
    if (json === lastSavedJson.current) return;
    const t = setTimeout(() => {
      saveSession("canvas", canvasId, model.title, model)
        .then(() => {
          lastSavedJson.current = json;
          setSaveMsg({ ok: true, text: "Saved, encrypted with your vault" });
          return listSessions("canvas").then(setSaved);
        })
        .catch((e) => setSaveMsg({ ok: false, text: `Not saved: ${String(e.message ?? e)}` }));
    }, SAVE_DELAY);
    return () => clearTimeout(t);
  }, [model, canvasId, loaded]);

  async function openSaved(id: string) {
    try {
      const s = await loadSession<unknown>("canvas", id);
      setUndo(null);
      show(layout(normalize(s.body)), id, true);
    } catch (e) {
      setSaveMsg({ ok: false, text: String((e as Error).message ?? e) });
    }
  }

  async function deleteSaved(id: string) {
    try {
      await deleteSession("canvas", id);
      if (id === canvasId) show(empty(), newSessionId(), false);
      await refreshSaved();
    } catch (e) {
      setSaveMsg({ ok: false, text: String((e as Error).message ?? e) });
    }
  }

  const chat = models.filter(isChatModel);
  const vision = chat.filter((m) => m.input_modalities?.includes("image"));
  const needsVision = att.images.length > 0;
  const choices = needsVision ? vision : chat;
  const [builder, setBuilder] = useState(config.model);
  // Keep the builder valid for the current input (a diagram needs a vision model).
  const builderId = choices.some((m) => m.id === builder) ? builder : choices[0]?.id ?? "";

  const s = stats(model);
  const node = model.nodes.find((n) => n.id === selected) ?? null;

  /**
   * A new canvas (build, import, clear): it gets its own id, so the one it replaces stays
   * saved; undo brings that one back, under its own id.
   */
  function replaceModel(next: ThreatModel) {
    // Flush edits still inside the auto-save delay, or they'd be lost with the old canvas.
    if (model.nodes.length && JSON.stringify(model) !== lastSavedJson.current) {
      saveSession("canvas", canvasId, model.title, model).catch(() => {});
    }
    setUndo({ model, id: canvasId });
    show(next, newSessionId(), false);
  }

  // --- editing -----------------------------------------------------------------------------
  const updateNode = (id: string, patch: Partial<TMNode>) =>
    setModel((m) => ({ ...m, nodes: m.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
  const updateFinding = (nodeId: string, fid: string, patch: Partial<Finding>) =>
    setModel((m) => ({
      ...m,
      nodes: m.nodes.map((n) => (n.id === nodeId ? { ...n, findings: n.findings.map((f) => (f.id === fid ? { ...f, ...patch } : f)) } : n)),
    }));

  function addNode() {
    const id = `component-${Date.now().toString(36)}`;
    setModel((m) => layout({ ...m, nodes: [...m.nodes, { id, label: "New component", kind: "service", details: [], inScope: true, tested: false, findings: [] }] }));
    setSelected(id);
  }
  function deleteNode(id: string) {
    setModel((m) => ({ ...m, nodes: m.nodes.filter((n) => n.id !== id), edges: m.edges.filter((e) => e.from !== id && e.to !== id) }));
    setSelected(null);
  }

  // --- build from diagram / description ----------------------------------------------------
  function build() {
    if (building || (!description.trim() && !att.images.length && !att.docs.length) || att.reading || !builderId) return;
    setBuilding(true);
    setBuildError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let text = "";
    runChat(
      {
        model: builderId,
        messages: [
          { role: "system", content: CANVAS_SYSTEM },
          { role: "user", content: userContent(canvasUserPrompt(description, att.images.length > 0 || att.docs.length > 0), att.images, att.docs) },
        ],
        temperature: 0.2,
        // A diagram file makes for a big model, and reasoning models think before the JSON, so
        // give them room (within the model's own output limit when the catalogue knows it).
        max_tokens: buildBudget(config.maxTokens, att.docs.length > 0, chat.find((m) => m.id === builderId)?.max_output_length),
        // Streamed so a long think doesn't hit the runner's "started answering" limit; only the
        // answer text (not reasoning) reaches onDelta, so `text` is just the JSON.
        stream: true,
      },
      {
        signal: ctrl.signal,
        onDelta: (t) => { text += t; },
        onError: (msg) => setBuildError(msg),
        onDone: (finish) => {
          if (!text.trim()) {
            setBuildError(finish === "length"
              ? "The model used its whole output limit thinking and wrote no threat model. Try again, raise Max tokens, or pick a faster model."
              : "The model returned no answer. Try again or pick another model.");
            return;
          }
          try {
            const next = layout(normalize(extractJson(text)));
            if (!next.nodes.length) throw new Error("The model returned no components.");
            replaceModel(next);
            setDescription("");
            att.clear();
          } catch (e) {
            setBuildError(finish === "length"
              ? "The model ran out of output tokens before finishing the threat model. Raise Max tokens or ask for fewer components."
              : `Couldn't read the model's threat model: ${(e as Error).message}`);
          }
        },
      },
    )
      .catch((e) => {
        if (e?.name !== "AbortError") setBuildError(String(e?.message ?? e));
      })
      .finally(() => {
        setBuilding(false);
        abortRef.current = null;
      });
  }

  // --- import / export ---------------------------------------------------------------------
  async function importFile(f: File) {
    try {
      replaceModel(layout(normalize(JSON.parse(await f.text()))));
    } catch (e) {
      setBuildError(`Import failed: ${(e as Error).message}`);
    }
  }
  const baseName = model.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "") || "threat-model";
  // Editable draw.io export through the runner's render service (drawgen), when it is there.
  const [drawioOn, setDrawioOn] = useState(false);
  const [exporting, setExporting] = useState(false);
  useEffect(() => { renderAvailable().then(setDrawioOn); }, []);
  async function exportDrawio() {
    setExporting(true);
    const out = await renderDrawio(toDrawioSpec(model));
    setExporting(false);
    if (out.ok) download(`${baseName}.drawio.svg`, out.r.svg, "image/svg+xml");
    else setSaveMsg({ ok: false, text: `draw.io export failed: ${out.error}` });
  }

  function exportSvg() {
    const svg = svgRef.current;
    if (!svg) return;
    const copy = svg.cloneNode(true) as SVGSVGElement;
    copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    copy.removeAttribute("class");
    copy.removeAttribute("style");
    // Export the whole model, whatever the current zoom.
    copy.setAttribute("viewBox", `${fit.x} ${fit.y} ${fit.w} ${fit.h}`);
    copy.setAttribute("width", String(Math.round(fit.w)));
    copy.setAttribute("height", String(Math.round(fit.h)));
    download(`${baseName}.svg`, new XMLSerializer().serializeToString(copy), "image/svg+xml");
  }

  // --- view: fit, zoom and pan -------------------------------------------------------------
  // `view` is null while the canvas fits its contents; zooming, panning or dragging a node pins
  // it so nothing rescales under the pointer. "fit" (and every new model) unpins it.
  const [view, setView] = useState<View | null>(null);
  const fit = useMemo<View>(() => {
    if (!model.nodes.length) return { x: 0, y: 0, w: 900, h: 520 };
    const xs = model.nodes.map((n) => n.x ?? 0);
    const ys = model.nodes.map((n) => n.y ?? 0);
    const x = Math.min(...xs) - 40, y = Math.min(...ys) - 40;
    return {
      x, y,
      w: Math.max(900, Math.max(...xs) + NODE_W + 40 - x),
      h: Math.max(520, Math.max(...ys) + NODE_H + 40 - y),
    };
  }, [model.nodes]);
  const shown = view ?? fit;
  const zoomPct = Math.round((fit.w / shown.w) * 100);
  const fitRef = useRef(fit);
  fitRef.current = fit;

  /** Zoom by `factor` (>1 = in) around an SVG point, default the centre; 25%–400% of fit. */
  function zoomAt(factor: number, px?: number, py?: number) {
    setView((v) => {
      const f0 = fitRef.current;
      const cur = v ?? f0;
      const w = Math.min(f0.w * 4, Math.max(f0.w / 4, cur.w / factor));
      const k = cur.w / w;
      const cx = px ?? cur.x + cur.w / 2, cy = py ?? cur.y + cur.h / 2;
      return { x: cx - (cx - cur.x) / k, y: cy - (cy - cur.y) / k, w, h: cur.h / k };
    });
  }

  function toSvg(clientX: number, clientY: number) {
    const pt = new DOMPoint(clientX, clientY).matrixTransform(svgRef.current!.getScreenCTM()!.inverse());
    return { x: pt.x, y: pt.y };
  }

  // Wheel zoom needs a non-passive listener to stop the page scrolling instead.
  const hasNodes = model.nodes.length > 0;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toSvg(e.clientX, e.clientY);
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [hasNodes]);

  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const pan = useRef<{ cx: number; cy: number; start: View; scale: number } | null>(null);
  const [panning, setPanning] = useState(false);

  function startDrag(e: React.PointerEvent, n: TMNode) {
    e.stopPropagation();
    setView(shown);
    const p = toSvg(e.clientX, e.clientY);
    drag.current = { id: n.id, dx: p.x - (n.x ?? 0), dy: p.y - (n.y ?? 0) };
    svgRef.current?.setPointerCapture(e.pointerId);
    setSelected(n.id);
  }
  function startPan(e: React.PointerEvent) {
    const r = svgRef.current!.getBoundingClientRect();
    // preserveAspectRatio "meet": one screen pixel is the larger of the two ratios in SVG units.
    pan.current = { cx: e.clientX, cy: e.clientY, start: shown, scale: Math.max(shown.w / r.width, shown.h / r.height) };
    svgRef.current?.setPointerCapture(e.pointerId);
    setPanning(true);
  }
  function onMove(e: React.PointerEvent) {
    const d = drag.current;
    if (d) {
      const p = toSvg(e.clientX, e.clientY);
      updateNode(d.id, { x: Math.round(p.x - d.dx), y: Math.round(p.y - d.dy) });
      return;
    }
    const pn = pan.current;
    if (pn) setView({ ...pn.start, x: pn.start.x - (e.clientX - pn.cx) * pn.scale, y: pn.start.y - (e.clientY - pn.cy) * pn.scale });
  }
  function endPointer() {
    drag.current = null;
    pan.current = null;
    setPanning(false);
  }

  const byId = new Map(model.nodes.map((n) => [n.id, n]));

  return (
    <main className="main">
      <TerminalBar title={`bugxhunter@playground: ~/canvas: ${clip(model.title, 40)}`}>
        <span className="status-pill"><span className="dot" />
          {s.components} components · {s.tested}/{s.inScope} tested · {s.open.critical + s.open.high} crit/high open
        </span>
        <button className="btn ghost sm" onClick={addNode}>+ component</button>
        <button className="btn ghost sm" onClick={() => importRef.current?.click()}>import</button>
        <button className="btn ghost sm" disabled={!model.nodes.length} onClick={() => download(`${baseName}.json`, JSON.stringify(model, null, 2), "application/json")}>json</button>
        <button className="btn ghost sm" disabled={!model.nodes.length} onClick={() => download(`${baseName}-findings.md`, findingsMarkdown(model), "text/markdown")}>findings.md</button>
        <button className="btn ghost sm" disabled={!model.nodes.length} onClick={exportSvg}>svg</button>
        {drawioOn && <button className="btn ghost sm" disabled={!model.nodes.length || exporting} onClick={exportDrawio} title="An editable diagram: opens in draw.io and its VS Code extension">{exporting ? "draw.io…" : "draw.io"}</button>}
        {undo && <button className="btn ghost sm" onClick={() => { show(undo.model, undo.id, false); setUndo(null); }}>undo</button>}
        <button className="btn ghost sm" disabled={!model.nodes.length} onClick={() => replaceModel(empty())}>clear</button>
        <button className="btn ghost sm" onClick={() => { abortRef.current?.abort(); onExit(); }}>back to chat</button>
        <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ""; }} />
      </TerminalBar>

      <div className="canvas-wrap">
        <div className="canvas-stage grid-bg" onPointerDown={() => setSelected(null)}>
          {hasNodes && (
            <div className="canvas-zoom" onPointerDown={(e) => e.stopPropagation()}>
              <button onClick={() => zoomAt(1 / 1.25)} title="Zoom out" aria-label="Zoom out">−</button>
              <span title="Zoom (100% = fit)">{zoomPct}%</span>
              <button onClick={() => zoomAt(1.25)} title="Zoom in" aria-label="Zoom in">+</button>
              <button onClick={() => setView(null)} title="Fit the whole model">fit</button>
            </div>
          )}
          {!model.nodes.length ? (
            <div className="empty-state center">
              <p className="muted mono">
                No threat model yet. Attach an architecture diagram or describe the system below,
                then <b>build</b>. Or add components by hand, or import a saved model.
              </p>
            </div>
          ) : (
            <svg
              ref={svgRef}
              className="canvas-svg"
              viewBox={`${shown.x} ${shown.y} ${shown.w} ${shown.h}`}
              preserveAspectRatio="xMidYMin meet"
              onPointerMove={onMove}
              onPointerUp={endPointer}
              onPointerCancel={endPointer}
              style={{ cursor: panning ? "grabbing" : undefined }}
            >
              <defs>
                <marker id="tm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="#6e7681" />
                </marker>
                <marker id="tm-arrow-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="#ff3c3c" />
                </marker>
              </defs>
              <rect x="-100000" y="-100000" width="200000" height="200000" fill="#0a0e14"
                style={{ cursor: panning ? "grabbing" : "grab" }} onPointerDown={startPan} />

              {model.edges.map((e) => {
                const a = byId.get(e.from), b = byId.get(e.to);
                if (!a || !b) return null;
                const ax = (a.x ?? 0) + NODE_W / 2, ay = (a.y ?? 0) + NODE_H / 2;
                const bx = (b.x ?? 0) + NODE_W / 2, by = (b.y ?? 0) + NODE_H / 2;
                // Stop the line at the target's border so the arrowhead shows.
                const dx = bx - ax, dy = by - ay;
                const t = Math.min(Math.abs((NODE_W / 2) / (dx || 1e-6)), Math.abs((NODE_H / 2) / (dy || 1e-6)), 1);
                const ex = bx - dx * t, ey = by - dy * t;
                const plain = e.encrypted === false;
                return (
                  <g key={e.id}>
                    <line x1={ax} y1={ay} x2={ex} y2={ey} stroke={plain ? "#ff3c3c" : "#6e7681"} strokeWidth={2}
                      strokeDasharray={plain ? "7 5" : undefined} markerEnd={`url(#${plain ? "tm-arrow-red" : "tm-arrow"})`} />
                    {e.label && (
                      <text x={(ax + ex) / 2} y={(ay + ey) / 2 - 7} fill={plain ? "#ff8080" : "#8b949e"} fontSize={12}
                        fontFamily="JetBrains Mono, monospace" textAnchor="middle">
                        {clip(e.label + (plain && !/plain/i.test(e.label) ? " (plaintext)" : ""), 34)}
                      </text>
                    )}
                  </g>
                );
              })}

              {model.nodes.map((n) => {
                const worst = worstOpen(n);
                const open = n.findings.filter((f) => f.status === "open").length;
                const x = n.x ?? 0, y = n.y ?? 0;
                return (
                  <g key={n.id} transform={`translate(${x},${y})`} opacity={n.inScope ? 1 : 0.45}
                    style={{ cursor: "grab" }} onPointerDown={(e) => startDrag(e, n)}>
                    <rect width={NODE_W} height={NODE_H} rx={10} fill="#161b22"
                      stroke={selected === n.id ? "#ffffff" : KIND_COLOR[n.kind]} strokeWidth={selected === n.id ? 2.5 : 1.5}
                      strokeDasharray={n.inScope ? undefined : "5 4"} />
                    {worst && <rect width={6} height={NODE_H} rx={3} fill={SEV_COLOR[worst]} />}
                    <text x={16} y={22} fill="#e6edf3" fontSize={14} fontWeight={700} fontFamily="Inter, system-ui, sans-serif">{clip(n.label, 22)}</text>
                    <text x={16} y={40} fill={KIND_COLOR[n.kind]} fontSize={10} fontFamily="JetBrains Mono, monospace">
                      {n.kind.toUpperCase()}{n.inScope ? "" : " · OUT OF SCOPE"}{n.tested ? " · TESTED ✓" : ""}
                    </text>
                    {n.details.slice(0, 2).map((d, i) => (
                      <text key={i} x={16} y={58 + i * 14} fill="#8b949e" fontSize={11} fontFamily="Inter, system-ui, sans-serif">{clip(d, 30)}</text>
                    ))}
                    {open > 0 && (
                      <g transform={`translate(${NODE_W - 30},8)`}>
                        <rect width={22} height={18} rx={9} fill={SEV_COLOR[worst ?? "low"]} />
                        <text x={11} y={13} fill="#0a0e14" fontSize={11} fontWeight={700} textAnchor="middle" fontFamily="Inter, system-ui, sans-serif">{open}</text>
                      </g>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        <aside className="canvas-panel">
          {node ? (
            <NodeInspector
              node={node}
              onChange={(p) => updateNode(node.id, p)}
              onFinding={(fid, p) => updateFinding(node.id, fid, p)}
              onAddFinding={(f) => updateNode(node.id, { findings: [...node.findings, f] })}
              onRemoveFinding={(fid) => updateNode(node.id, { findings: node.findings.filter((f) => f.id !== fid) })}
              onDelete={() => deleteNode(node.id)}
            />
          ) : (
            <div className="canvas-summary">
              <label>Title</label>
              <input type="text" value={model.title} onChange={(e) => setModel((m) => ({ ...m, title: e.target.value }))} />
              <div className="section-title">Summary</div>
              <ul className="canvas-stats">
                <li>{s.components} components, {s.inScope} in scope</li>
                <li>Coverage: {s.tested}/{s.inScope} tested</li>
                {SEVERITIES.map((sev) => (
                  <li key={sev}><span className="sev-dot" style={{ background: SEV_COLOR[sev] }} />{s.open[sev]} {sev} open</li>
                ))}
                <li>{s.fixed} fixed or verified</li>
                <li>{s.plaintextFlows} plaintext flow{s.plaintextFlows === 1 ? "" : "s"}</li>
              </ul>
              <p className="hint">Click a component to edit it, mark scope and coverage, and track its findings. Drag to rearrange.</p>

              <div className="section-title">Saved canvases</div>
              {saveMsg && <div className="hint" style={{ color: saveMsg.ok ? "var(--muted)" : "var(--amber)" }}>{saveMsg.text}</div>}
              <button className="btn ghost sm block" onClick={() => replaceModel(empty())} disabled={!model.nodes.length}>+ New canvas</button>
              <SavedCanvasList list={saved} activeId={canvasId} onOpen={(id) => void openSaved(id)} onDelete={(id) => void deleteSaved(id)} />
            </div>
          )}
        </aside>
      </div>

      <div className="composer">
        <div className="composer-box" onDragOver={(e) => e.preventDefault()} onDrop={att.onDrop}>
          <AttachChips images={att.images} docs={att.docs} reading={att.reading} onRemove={att.remove} onRemoveDoc={att.removeDoc} />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onPaste={att.onPaste}
            rows={2}
            placeholder="Attach an architecture diagram, or describe the system (components, data stores, flows)…"
          />
          <div className="composer-bar">
            <input ref={fileRef} type="file" accept={ATTACH_ACCEPT} multiple hidden
              onChange={(e) => { if (e.target.files) void att.addImages(e.target.files); e.target.value = ""; }} />
            <button className="icon-btn attach-btn" onClick={() => fileRef.current?.click()} disabled={building} title="Attach a diagram (or paste / drop it)" aria-label="Attach a diagram">
              <PaperclipIcon />
            </button>
            <select className="canvas-builder" value={builderId} onChange={(e) => setBuilder(e.target.value)} disabled={building} aria-label="Model that builds the threat model">
              {!choices.length && <option value="">{needsVision ? "No vision model available" : "No models"}</option>}
              {choices.map((m) => <option key={m.id} value={m.id}>{m.name}{m.input_modalities?.includes("image") ? " · vision" : ""}</option>)}
            </select>
            {(buildError || att.attachError) && (
              <span className="hint" style={{ color: "var(--amber)", margin: "0 8px" }}>{buildError ?? att.attachError}</span>
            )}
            <div className="spacer" />
            {building ? (
              <button className="send-btn stop" onClick={() => abortRef.current?.abort()} title="Stop">■</button>
            ) : (
              <button className="btn primary sm" onClick={build} disabled={(!description.trim() && !att.images.length && !att.docs.length) || att.reading || !builderId}>
                {model.nodes.length ? "rebuild" : "build"}
              </button>
            )}
          </div>
        </div>
        <div className="composer-hint">
          {building ? "Building the threat model… (reasoning models can take several minutes on a big diagram)" : "Each build starts a new saved canvas; undo brings the previous one back. Saved on the runner, encrypted with your vault."}
        </div>
      </div>
    </main>
  );
}

function SavedCanvasList({ list, activeId, onOpen, onDelete }: {
  list: SavedSession[]; activeId: string; onOpen: (id: string) => void; onDelete: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), 3000);
    return () => clearTimeout(t);
  }, [confirming]);
  if (!list.length) return <div className="hint">No saved canvases yet. Build one and it saves itself.</div>;
  return (
    <div className="session-list">
      {list.map((s) => (
        <div key={s.id} className={"session-item" + (s.id === activeId ? " on" : "")}>
          <button className="session-open" onClick={() => onOpen(s.id)} title={s.title}>
            <span className="session-title">{s.title || "Untitled threat model"}</span>
            <span className="session-meta">{new Date(s.updatedAt).toLocaleString()}</span>
          </button>
          <button
            className={"session-del" + (confirming === s.id ? " confirm" : "")}
            onClick={() => {
              if (confirming !== s.id) return setConfirming(s.id);
              setConfirming(null);
              onDelete(s.id);
            }}
            title={confirming === s.id ? "Click again to delete" : "Delete canvas"}
            aria-label={confirming === s.id ? "Confirm delete" : "Delete canvas"}
          >
            {confirming === s.id ? "Delete?" : "✕"}
          </button>
        </div>
      ))}
    </div>
  );
}

function NodeInspector({ node, onChange, onFinding, onAddFinding, onRemoveFinding, onDelete }: {
  node: TMNode;
  onChange: (p: Partial<TMNode>) => void;
  onFinding: (fid: string, p: Partial<Finding>) => void;
  onAddFinding: (f: Finding) => void;
  onRemoveFinding: (fid: string) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState("");
  const [sev, setSev] = useState<Severity>("medium");
  return (
    <div className="canvas-inspector">
      <label>Component</label>
      <input type="text" value={node.label} onChange={(e) => onChange({ label: e.target.value })} />
      <label>Kind</label>
      <select value={node.kind} onChange={(e) => onChange({ kind: e.target.value as NodeKind })}>
        {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <label className="check"><input type="checkbox" checked={node.inScope} onChange={(e) => onChange({ inScope: e.target.checked })} /> In scope</label>
      <label className="check"><input type="checkbox" checked={node.tested} onChange={(e) => onChange({ tested: e.target.checked })} /> Tested</label>
      {node.details.length > 0 && (
        <>
          <div className="section-title">Details</div>
          <ul className="canvas-details">{node.details.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </>
      )}
      <div className="section-title">Findings ({node.findings.length})</div>
      {node.findings.map((f) => (
        <div className="canvas-finding" key={f.id}>
          <div className="cf-head">
            <span className="sev-pill" style={{ background: SEV_COLOR[f.severity] }}>{f.severity}</span>
            <span className="cf-title">{f.title}</span>
            <button className="attach-x" onClick={() => onRemoveFinding(f.id)} aria-label="Remove finding">✕</button>
          </div>
          {f.fix && <div className="cf-fix">Fix: {f.fix}</div>}
          {f.ref && <div className="cf-ref">{f.ref}</div>}
          <select value={f.status} onChange={(e) => onFinding(f.id, { status: e.target.value as FindingStatus })}>
            <option value="open">open</option>
            <option value="fixed">fixed</option>
            <option value="verified">verified (retested)</option>
          </select>
        </div>
      ))}
      <div className="cf-add">
        <input type="text" placeholder="Add a finding…" value={title} onChange={(e) => setTitle(e.target.value)} />
        <select value={sev} onChange={(e) => setSev(e.target.value as Severity)}>
          {SEVERITIES.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <button
          className="btn mini"
          disabled={!title.trim()}
          onClick={() => {
            onAddFinding({ id: `${node.id}-f${Date.now().toString(36)}`, title: title.trim(), severity: sev, status: "open" });
            setTitle("");
          }}
        >
          add
        </button>
      </div>
      <button className="btn danger-outline sm" style={{ marginTop: 14 }} onClick={onDelete}>delete component</button>
    </div>
  );
}
