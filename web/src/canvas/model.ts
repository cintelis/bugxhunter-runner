// The threat-model canvas: a graph of the system under review (actors, services, data stores,
// external systems), the flows between them, and the findings attached to each component.
// It is plain JSON so a model can produce it (from a diagram or a description), a person can
// edit it, and it can be exported and fed back in later. Positions live on the nodes; anything
// a model leaves out is filled in by normalize() and layout().

export type NodeKind = "actor" | "service" | "datastore" | "external";
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

export interface TMEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  encrypted?: boolean;
}

export interface ThreatModel {
  title: string;
  nodes: TMNode[];
  edges: TMEdge[];
}

const KINDS: NodeKind[] = ["actor", "service", "datastore", "external"];
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const empty = (): ThreatModel => ({ title: "Untitled threat model", nodes: [], edges: [] });

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v.trim() : fallback);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "node";

function asKind(v: unknown): NodeKind {
  const k = str(v).toLowerCase();
  if ((KINDS as string[]).includes(k)) return k as NodeKind;
  if (/user|client|admin|customer|attacker|person|internet/.test(k)) return "actor";
  if (/db|database|store|bucket|storage|cache|queue|file|repo|config|secret/.test(k)) return "datastore";
  if (/third|external|saas|vendor|partner/.test(k)) return "external";
  return "service";
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
    const findings = (Array.isArray(o.findings) ? o.findings : []).flatMap((f, j): Finding[] => {
      if (!f || typeof f !== "object") return [];
      const fo = f as Record<string, unknown>;
      const title = str(fo.title) || str(fo.issue) || str(fo.name);
      if (!title) return [];
      const status = str(fo.status).toLowerCase();
      return [{
        id: `${id}-f${j + 1}`,
        title,
        severity: asSeverity(fo.severity),
        fix: str(fo.fix) || str(fo.mitigation) || undefined,
        ref: str(fo.ref) || str(fo.cwe) || undefined,
        status: status === "fixed" || status === "verified" ? status : "open",
      }];
    });
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
    return [{
      id: `e${i + 1}`,
      from,
      to,
      label: str(o.label) || str(o.protocol) || undefined,
      encrypted: typeof o.encrypted === "boolean" ? o.encrypted : undefined,
    }];
  });

  return { title: str(r.title) || "Untitled threat model", nodes, edges };
}

export const NODE_W = 200;
export const NODE_H = 86;
const COL_GAP = 110;
const ROW_GAP = 46;
const COLUMN: Record<NodeKind, number> = { actor: 0, service: 1, datastore: 2, external: 3 };

/** Give unplaced nodes a position: one column per kind, left to right in the order data flows. */
export function layout(model: ThreatModel): ThreatModel {
  const rows = [0, 0, 0, 0];
  for (const n of model.nodes) if (n.x !== undefined && n.y !== undefined) rows[COLUMN[n.kind]]++;
  const nodes = model.nodes.map((n) => {
    if (n.x !== undefined && n.y !== undefined) return n;
    const col = COLUMN[n.kind];
    const row = rows[col]++;
    return { ...n, x: 40 + col * (NODE_W + COL_GAP), y: 40 + row * (NODE_H + ROW_GAP) };
  });
  return { ...model, nodes };
}

/** The worst open finding on a node, which decides its colour. */
export function worstOpen(n: TMNode): Severity | null {
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
}

export function stats(model: ThreatModel): Stats {
  const open: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  let fixed = 0;
  for (const n of model.nodes)
    for (const f of n.findings) {
      if (f.status === "open") open[f.severity]++;
      else fixed++;
    }
  const scoped = model.nodes.filter((n) => n.inScope);
  return {
    components: model.nodes.length,
    inScope: scoped.length,
    tested: scoped.filter((n) => n.tested).length,
    open,
    fixed,
    plaintextFlows: model.edges.filter((e) => e.encrypted === false).length,
  };
}

/** A findings table for a report, worst first. */
export function findingsMarkdown(model: ThreatModel): string {
  const rows = model.nodes
    .flatMap((n) => n.findings.map((f) => ({ n, f })))
    .sort((a, b) => SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity]);
  const cell = (s = "") => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    `# ${cell(model.title)}`,
    "",
    "| Severity | Component | Finding | Fix | Ref | Status |",
    "|---|---|---|---|---|---|",
    ...rows.map(({ n, f }) => `| ${f.severity} | ${cell(n.label)} | ${cell(f.title)} | ${cell(f.fix)} | ${cell(f.ref)} | ${f.status} |`),
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
        const plain = e.encrypted === false && !/plain/i.test(e.label ?? "");
        const label = [e.label, plain ? "(plaintext)" : ""].filter(Boolean).join(" ");
        return { from: ids.get(e.from), to: ids.get(e.to), style: "data", ...(label ? { label: short(label, 40) } : {}) };
      }),
    legend: true,
  };
}

/** Output tokens for a canvas build: the user's setting, raised for diagram files (big models,
 *  plus reasoning before the JSON), never above the model's own limit when it is known. */
export function buildBudget(userMax: number, fromDiagramFile: boolean, modelMax?: number | null): number {
  const want = Math.max(userMax, fromDiagramFile ? 32768 : 8192);
  return modelMax && modelMax > 0 ? Math.min(want, Math.max(modelMax, 1024)) : want;
}
