// The threat-model canvas: a graph of the system under review (actors, services, data stores,
// external systems), the flows between them, and the findings attached to each component.
// It is plain JSON so a model can produce it (from a diagram or a description), a person can
// edit it, and it can be exported and fed back in later. Positions live on the nodes; anything
// a model leaves out is filled in by normalize() and layout().

/** "ai" is a model, an LLM endpoint, an agent, a copilot or a RAG retriever: assessed with ATLAS as well as STRIDE. */
export type NodeKind = "actor" | "service" | "ai" | "datastore" | "external";
export type Severity = "critical" | "high" | "medium" | "low";
export type FindingStatus = "open" | "fixed" | "verified";

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  fix?: string;
  /** CWE or ATT&CK reference, free text (e.g. "CWE-798"). */
  ref?: string;
  status: FindingStatus;
}

export interface TMNode {
  id: string;
  label: string;
  kind: NodeKind;
  /** Short facts read off the source: versions, ports, settings. */
  details: string[];
  inScope: boolean;
  tested: boolean;
  findings: Finding[];
  x?: number;
  y?: number;
}

/**
 * What a flow carries. Colour on the canvas and the draw.io style follow it; "blocked" is a path
 * the source shows as cut (e.g. host management disabled by BlueField Restricted mode).
 */
export type FlowKind = "data" | "management" | "attestation" | "identity" | "control" | "blocked";
export const FLOW_KINDS: FlowKind[] = ["data", "management", "attestation", "identity", "control", "blocked"];
export const FLOW_LABEL: Record<FlowKind, string> = {
  data: "Data",
  management: "Management",
  attestation: "Attestation / evidence",
  identity: "Identity / credential",
  control: "Control / config",
  blocked: "Blocked",
};

export interface TMEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  kind: FlowKind;
  /** true = encrypted, false = plaintext, undefined = the source doesn't say. */
  encrypted?: boolean;
  /** Not drawn in the source, but implied by its labels. */
  implied?: boolean;
  /** e.g. "Redfish over HTTPS", "SPDM 1.1". */
  protocol?: string;
  /** e.g. "mTLS", "none". */
  auth?: string;
  findings: Finding[];
}

export interface ThreatModel {
  title: string;
  nodes: TMNode[];
  edges: TMEdge[];
}

const KINDS: NodeKind[] = ["actor", "service", "ai", "datastore", "external"];
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const empty = (): ThreatModel => ({ title: "Untitled threat model", nodes: [], edges: [] });

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v.trim() : fallback);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "node";

function asKind(v: unknown): NodeKind {
  const k = str(v).toLowerCase();
  if ((KINDS as string[]).includes(k)) return k as NodeKind;
  if (/user|client|admin|customer|attacker|person|internet/.test(k)) return "actor";
  if (/\b(ai|llm|model|agent|copilot|assistant|rag|retriev|inference|embedding)/.test(k)) return "ai";
  if (/db|database|store|bucket|storage|cache|queue|file|repo|config|secret/.test(k)) return "datastore";
  if (/third|external|saas|vendor|partner/.test(k)) return "external";
  return "service";
}

function asFlowKind(v: unknown, label: string): FlowKind {
  const k = str(v).toLowerCase();
  if ((FLOW_KINDS as string[]).includes(k)) return k as FlowKind;
  if (!k) return /\bblocked\b/i.test(label) ? "blocked" : "data";
  if (/block|denied|disabled|cut/.test(k)) return "blocked";
  if (/attest|evidence|spdm|measure/.test(k)) return "attestation";
  if (/ident|credential|cert|svid|token|key|auth/.test(k)) return "identity";
  if (/manag|admin|mgmt|bmc|redfish|ssh|console/.test(k)) return "management";
  if (/control|config|crd|gitops|policy|deploy|boot|admission/.test(k)) return "control";
  return "data";
}

function parseFindings(list: unknown, idPrefix: string): Finding[] {
  return (Array.isArray(list) ? list : []).flatMap((f, j): Finding[] => {
    if (!f || typeof f !== "object") return [];
    const fo = f as Record<string, unknown>;
    const title = str(fo.title) || str(fo.issue) || str(fo.name);
    if (!title) return [];
    const status = str(fo.status).toLowerCase();
    return [{
      id: `${idPrefix}-f${j + 1}`,
      title,
      severity: asSeverity(fo.severity),
      fix: str(fo.fix) || str(fo.mitigation) || undefined,
      ref: str(fo.ref) || str(fo.cwe) || undefined,
      status: status === "fixed" || status === "verified" ? status : "open",
    }];
  });
}

function asSeverity(v: unknown): Severity {
  const s = str(v).toLowerCase();
  if ((SEVERITIES as string[]).includes(s)) return s as Severity;
  if (s.startsWith("crit") || s === "p1") return "critical";
  if (s.startsWith("hi") || s === "p2") return "high";
  if (s.startsWith("lo") || s === "p4" || s === "p5" || s.startsWith("info")) return "low";
  return "medium";
}

/** Pull the first JSON object out of model output (bare, or inside a ``` fence). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in the model's reply.");
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * Coerce untrusted JSON (model output or an imported file) into a valid ThreatModel: ids are
 * made unique, unknown kinds and severities are mapped, and edges that point at nodes that
 * don't exist are dropped. Never throws on shape, only on non-object input.
 */
export function normalize(raw: unknown): ThreatModel {
  if (!raw || typeof raw !== "object") throw new Error("Threat model must be a JSON object.");
  const r = raw as Record<string, unknown>;
  const used = new Set<string>();
  const unique = (base: string) => {
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
    used.add(id);
    return id;
  };

  const idMap = new Map<string, string>();
  const nodes: TMNode[] = (Array.isArray(r.nodes) ? r.nodes : []).flatMap((n, i): TMNode[] => {
    if (!n || typeof n !== "object") return [];
    const o = n as Record<string, unknown>;
    const label = str(o.label) || str(o.name) || `Component ${i + 1}`;
    const given = str(o.id) || slug(label);
    const id = unique(slug(given));
    // First node wins a shared id or label, so a duplicate can't steal the original's edges.
    if (!idMap.has(given)) idMap.set(given, id);
    if (!idMap.has(label)) idMap.set(label, id);
    const findings = parseFindings(o.findings, id);
    return [{
      id,
      label,
      kind: asKind(o.kind ?? o.type),
      details: (Array.isArray(o.details) ? o.details : []).map((d) => str(d)).filter(Boolean).slice(0, 8),
      inScope: o.inScope !== false,
      tested: o.tested === true,
      findings,
      x: typeof o.x === "number" ? o.x : undefined,
      y: typeof o.y === "number" ? o.y : undefined,
    }];
  });

  const edges: TMEdge[] = (Array.isArray(r.edges) ? r.edges : []).flatMap((e, i): TMEdge[] => {
    if (!e || typeof e !== "object") return [];
    const o = e as Record<string, unknown>;
    const from = idMap.get(str(o.from)) ?? idMap.get(slug(str(o.from)));
    const to = idMap.get(str(o.to)) ?? idMap.get(slug(str(o.to)));
    if (!from || !to || from === to) return [];
    // "(implied)" at the end of a label (how models were asked to mark them before) sets the flag.
    let label = str(o.label);
    const impliedSuffix = /\s*\(implied\)\s*$/i.test(label);
    if (impliedSuffix) label = label.replace(/\s*\(implied\)\s*$/i, "");
    const id = `e${i + 1}`;
    return [{
      id,
      from,
      to,
      label: label || str(o.protocol) || undefined,
      kind: asFlowKind(o.kind ?? o.type, label),
      encrypted: typeof o.encrypted === "boolean" ? o.encrypted : undefined,
      implied: o.implied === true || impliedSuffix || undefined,
      protocol: str(o.protocol) || undefined,
      auth: str(o.auth) || str(o.authentication) || undefined,
      findings: parseFindings(o.findings, id),
    }];
  });

  return { title: str(r.title) || "Untitled threat model", nodes, edges };
}

export const NODE_W = 200;
export const NODE_H = 86;
const COL_GAP = 120;
const ROW_GAP = 40;
const PITCH_X = NODE_W + COL_GAP;
const PITCH_Y = NODE_H + ROW_GAP;
/** A column taller than this wraps into the next one, so big systems spread sideways. */
const MAX_ROWS = 6;
const KIND_ORDER: Record<NodeKind, number> = { actor: 0, external: 1, service: 2, ai: 3, datastore: 4 };
const placed = (n: TMNode) => n.x !== undefined && n.y !== undefined;

/**
 * Give unplaced nodes a position. A fresh model is laid out left to right along its flows;
 * cards added to a canvas that is already arranged go in a row under it.
 */
export function layout(model: ThreatModel): ThreatModel {
  const todo = model.nodes.filter((n) => !placed(n));
  if (!todo.length) return model;
  if (todo.length === model.nodes.length) return { ...model, nodes: arrange(model.nodes, model.edges) };
  const done = model.nodes.filter(placed);
  const left = Math.min(...done.map((n) => n.x!));
  const below = Math.max(...done.map((n) => n.y!)) + PITCH_Y;
  let i = 0;
  const nodes = model.nodes.map((n) => {
    if (placed(n)) return n;
    const at = i++;
    return { ...n, x: left + (at % 4) * PITCH_X, y: below + Math.floor(at / 4) * PITCH_Y };
  });
  return { ...model, nodes };
}

/** Throw away every position and lay the whole canvas out again. */
export function tidy(model: ThreatModel): ThreatModel {
  return layout({ ...model, nodes: model.nodes.map(({ x: _x, y: _y, ...n }) => n) });
}

/**
 * Layered left-to-right layout: each card sits one column right of whatever flows into it,
 * cards in a column are ordered to cut crossings, and cards with no flows go in a grid below.
 */
function arrange(nodes: TMNode[], edges: TMEdge[]): TMNode[] {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const out = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set()]));
  const inc = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set()]));
  for (const e of edges) {
    if (e.from === e.to || !out.has(e.from) || !out.has(e.to)) continue;
    out.get(e.from)!.add(e.to);
    inc.get(e.to)!.add(e.from);
  }
  const linked = nodes.filter((n) => out.get(n.id)!.size || inc.get(n.id)!.size);
  const lone = nodes.filter((n) => !out.get(n.id)!.size && !inc.get(n.id)!.size);

  // 1. Drop the flows that close a loop, starting from cards nothing flows into.
  const starts = [...linked].sort((a, b) =>
    (inc.get(a.id)!.size ? 1 : 0) - (inc.get(b.id)!.size ? 1 : 0) ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || index.get(a.id)! - index.get(b.id)!);
  const fwd = new Map<string, string[]>(linked.map((n) => [n.id, []]));
  const back = new Map<string, string[]>(linked.map((n) => [n.id, []]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const t of out.get(id)!) {
      if (state.get(t) === 1) continue;
      fwd.get(id)!.push(t);
      back.get(t)!.push(id);
      if (!state.has(t)) visit(t);
    }
    state.set(id, 2);
  };
  for (const n of starts) if (!state.has(n.id)) visit(n.id);

  // 2. Columns: the longest chain of flows into each card.
  const order: string[] = [];
  const waiting = new Map(linked.map((n) => [n.id, back.get(n.id)!.length]));
  const queue = linked.filter((n) => !waiting.get(n.id)).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const t of fwd.get(id)!) {
      waiting.set(t, waiting.get(t)! - 1);
      if (!waiting.get(t)) queue.push(t);
    }
  }
  const rank = new Map<string, number>();
  for (const id of order) rank.set(id, Math.max(0, ...back.get(id)!.map((p) => rank.get(p)! + 1)));
  // A starting card (a scheduler, an identity provider) sits just left of what it feeds,
  // not out in column 0; people stay on the far left.
  for (const id of [...order].reverse()) {
    const n = nodes[index.get(id)!];
    if (back.get(id)!.length || !fwd.get(id)!.length || n.kind === "actor") continue;
    rank.set(id, Math.max(0, Math.min(...fwd.get(id)!.map((t) => rank.get(t)!)) - 1));
  }

  // 3. Order each column by where its neighbours sit, sweeping right then left a few times.
  const columns: string[][] = [];
  for (const id of order) (columns[rank.get(id)!] ??= []).push(id);
  const layers = columns.filter(Boolean);
  const centre = new Map<string, number>();
  const measure = () => layers.forEach((l) => l.forEach((id, i) => centre.set(id, i - (l.length - 1) / 2)));
  measure();
  for (let sweep = 0; sweep < 8; sweep++) {
    const rightward = sweep % 2 === 0;
    for (const layer of rightward ? layers : [...layers].reverse()) {
      const r = rank.get(layer[0])!;
      const score = new Map(layer.map((id) => {
        const near = [...inc.get(id)!, ...out.get(id)!].filter((t) => rank.has(t) && (rightward ? rank.get(t)! < r : rank.get(t)! > r));
        return [id, near.length ? near.reduce((s, t) => s + centre.get(t)!, 0) / near.length : centre.get(id)!];
      }));
      layer.sort((a, b) => score.get(a)! - score.get(b)!);
      layer.forEach((id, i) => centre.set(id, i - (layer.length - 1) / 2));
    }
  }

  // 4. Positions, each column centred on the tallest; tall columns wrap into extra columns.
  const tallest = Math.min(MAX_ROWS, Math.max(0, ...layers.map((l) => l.length)));
  const pos = new Map<string, { x: number; y: number }>();
  let col = 0;
  for (const layer of layers) {
    const wraps = Math.ceil(layer.length / MAX_ROWS);
    const per = Math.ceil(layer.length / wraps);
    layer.forEach((id, i) => {
      const c = Math.floor(i / per);
      const count = Math.min(per, layer.length - c * per);
      pos.set(id, { x: 40 + (col + c) * PITCH_X, y: 40 + ((tallest - count) / 2 + (i % per)) * PITCH_Y });
    });
    col += wraps;
  }

  // 5. Cards without flows: a grid under the graph, grouped by kind.
  const top = layers.length ? 40 + (tallest + 0.5) * PITCH_Y : 40;
  const across = Math.max(4, col);
  [...lone].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || index.get(a.id)! - index.get(b.id)!)
    .forEach((n, i) => pos.set(n.id, { x: 40 + (i % across) * PITCH_X, y: top + Math.floor(i / across) * PITCH_Y }));

  return nodes.map((n) => ({ ...n, ...pos.get(n.id)! }));
}

/** The worst open finding on a node, which decides its colour. */
export function worstOpen(n: { findings: Finding[] }): Severity | null {
  let worst: Severity | null = null;
  for (const f of n.findings) {
    if (f.status !== "open") continue;
    if (!worst || SEVERITY_RANK[f.severity] < SEVERITY_RANK[worst]) worst = f.severity;
  }
  return worst;
}

export interface Stats {
  components: number;
  inScope: number;
  tested: number;
  open: Record<Severity, number>;
  fixed: number;
  plaintextFlows: number;
  flows: number;
  impliedFlows: number;
  blockedFlows: number;
  /** Flows per kind, for the legend. */
  byKind: Record<FlowKind, number>;
}

export function stats(model: ThreatModel): Stats {
  const open: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  let fixed = 0;
  // Findings on flows count the same as findings on components.
  for (const f of [...model.nodes.flatMap((n) => n.findings), ...model.edges.flatMap((e) => e.findings ?? [])]) {
    if (f.status === "open") open[f.severity]++;
    else fixed++;
  }
  const byKind = Object.fromEntries(FLOW_KINDS.map((k) => [k, 0])) as Record<FlowKind, number>;
  for (const e of model.edges) byKind[e.kind ?? "data"]++;
  const scoped = model.nodes.filter((n) => n.inScope);
  return {
    components: model.nodes.length,
    inScope: scoped.length,
    tested: scoped.filter((n) => n.tested).length,
    open,
    fixed,
    plaintextFlows: model.edges.filter((e) => e.encrypted === false).length,
    flows: model.edges.length,
    impliedFlows: model.edges.filter((e) => e.implied).length,
    blockedFlows: byKind.blocked,
    byKind,
  };
}

/** A findings table for a report, worst first. */
export function findingsMarkdown(model: ThreatModel): string {
  const name = new Map(model.nodes.map((n) => [n.id, n.label]));
  const rows = [
    ...model.nodes.flatMap((n) => n.findings.map((f) => ({ where: n.label, f }))),
    ...model.edges.flatMap((e) => (e.findings ?? []).map((f) => ({
      where: `${name.get(e.from) ?? e.from} → ${name.get(e.to) ?? e.to} (${FLOW_LABEL[e.kind ?? "data"].toLowerCase()} flow)`,
      f,
    }))),
  ].sort((a, b) => SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity]);
  const cell = (s = "") => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    `# ${cell(model.title)}`,
    "",
    "| Severity | Component or flow | Finding | Fix | Ref | Status |",
    "|---|---|---|---|---|---|",
    ...rows.map(({ where, f }) => `| ${f.severity} | ${cell(where)} | ${cell(f.title)} | ${cell(f.fix)} | ${cell(f.ref)} | ${f.status} |`),
  ];
  return lines.join("\n") + "\n";
}

/**
 * The model as a drawgen spec (https://github.com/cintelis/drawio-tools), for an editable
 * draw.io export. Nodes keep their canvas positions; each one's second line says what is
 * open on it, and plaintext flows are named on the arrow, since colour only means type there.
 */
export function toDrawioSpec(model: ThreatModel): Record<string, unknown> {
  const placed = layout(model);
  const ids = new Map(placed.nodes.map((n, i) => [n.id, `n${i}-${slug(n.id)}`]));
  const short = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
  const sub = (n: TMNode) => {
    if (!n.inScope) return "out of scope";
    const open = SEVERITIES.map((s) => [s, n.findings.filter((f) => f.status === "open" && f.severity === s).length] as const)
      .filter(([, c]) => c > 0);
    return open.length ? open.map(([s, c]) => `${c} ${s}`).join(" · ") : "no open findings";
  };
  const minX = Math.min(...placed.nodes.map((n) => n.x ?? 0));
  const minY = Math.min(...placed.nodes.map((n) => n.y ?? 0));
  return {
    title: short(model.title || "Threat model", 80),
    nodes: placed.nodes.map((n) => ({
      id: ids.get(n.id),
      label: short(n.label, 40),
      kind: n.kind,
      sub: sub(n),
      x: Math.round((n.x ?? 0) - minX + 40),
      y: Math.round((n.y ?? 0) - minY + 90),
      w: NODE_W,
      h: NODE_H,
    })),
    edges: placed.edges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e) => {
        const kind = e.kind ?? "data";
        const plain = e.encrypted === false && !/plain/i.test(e.label ?? "");
        // drawgen's arrow styles have their own names, so the flow type goes in the label and the
        // style only keeps the kinds apart: red dashed = plaintext, grey dashed = blocked.
        const style = plain ? "async" : kind === "blocked" ? "weak"
          : kind === "management" || kind === "control" ? "sync"
          : kind === "attestation" || kind === "identity" ? "ai" : "data";
        const label = [kind === "data" ? "" : `${kind}:`, e.label, plain ? "(plaintext)" : "", e.implied ? "(implied)" : ""]
          .filter(Boolean).join(" ");
        return { from: ids.get(e.from), to: ids.get(e.to), style, ...(label ? { label: short(label, 48) } : {}) };
      }),
    legend: { edges: [] }, // component kinds only: drawgen's edge names would mislabel these flows
  };
}

/** Output tokens for a canvas build: the user's setting, raised for diagram files (big models,
 *  plus reasoning before the JSON), never above the model's own limit when it is known. */
export function buildBudget(userMax: number, fromDiagramFile: boolean, modelMax?: number | null): number {
  const want = Math.max(userMax, fromDiagramFile ? 65536 : 8192);
  return modelMax && modelMax > 0 ? Math.min(want, Math.max(modelMax, 1024)) : want;
}
