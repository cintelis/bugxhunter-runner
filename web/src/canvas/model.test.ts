import { describe, expect, it } from "vitest";
import { buildBudget, extractJson, findingsMarkdown, layout, normalize, stats, toDrawioSpec, worstOpen } from "./model";

describe("extractJson", () => {
  it("reads a fenced block or a bare object surrounded by prose", () => {
    expect(extractJson('Here you go:\n```json\n{"title":"A"}\n```')).toEqual({ title: "A" });
    expect(extractJson('Sure. {"title":"B","nodes":[]} Hope that helps.')).toEqual({ title: "B", nodes: [] });
  });
  it("throws when there is no object", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("normalize", () => {
  const raw = {
    title: "Acme",
    nodes: [
      { id: "web", label: "Web Server", kind: "service", details: ["PHP 7.2"], findings: [{ title: "debug on", severity: "HIGH", fix: "turn it off" }] },
      { label: "Database", kind: "mysql db", findings: [{ issue: "root no password", severity: "crit", cwe: "CWE-521" }, { severity: "low" }] },
      { id: "web", label: "Duplicate id", kind: "weird" },
      "not a node",
    ],
    edges: [
      { from: "web", to: "Database", protocol: "MySQL :3306", encrypted: false },
      { from: "web", to: "ghost" },
      { from: "web", to: "web" },
    ],
  };
  const m = normalize(raw);

  it("keeps valid nodes, makes ids unique and maps loose kinds and severities", () => {
    expect(m.nodes.map((n) => n.id)).toEqual(["web", "database", "web-2"]);
    expect(m.nodes[1].kind).toBe("datastore");
    expect(m.nodes[2].kind).toBe("service");
    expect(m.nodes[0].findings[0].severity).toBe("high");
    expect(m.nodes[1].findings).toHaveLength(1); // the untitled finding is dropped
    expect(m.nodes[1].findings[0]).toMatchObject({ severity: "critical", ref: "CWE-521", status: "open" });
    expect(m.nodes[0].inScope).toBe(true);
  });

  it("resolves edges by id or label and drops dangling and self edges", () => {
    expect(m.edges).toMatchObject([{ id: "e1", from: "web", to: "database", label: "MySQL :3306", encrypted: false }]);
  });

  it("rejects non-objects", () => {
    expect(() => normalize(null)).toThrow();
  });
});

describe("layout, worstOpen, stats, findingsMarkdown", () => {
  const m = layout(normalize({
    title: "T",
    nodes: [
      { id: "u", label: "User", kind: "actor" },
      { id: "s", label: "API", kind: "service", tested: true, findings: [{ title: "x", severity: "medium" }, { title: "y", severity: "critical", status: "fixed" }] },
      { id: "d", label: "DB", kind: "datastore", inScope: false, findings: [{ title: "z", severity: "high" }] },
    ],
    edges: [{ from: "u", to: "s", encrypted: false }],
  }));

  it("places each kind in its own column", () => {
    const xs = m.nodes.map((n) => n.x);
    expect(new Set(xs).size).toBe(3);
    expect(m.nodes.every((n) => n.y !== undefined)).toBe(true);
  });

  it("colours by the worst open finding only", () => {
    expect(worstOpen(m.nodes[1])).toBe("medium");
    expect(worstOpen(m.nodes[0])).toBeNull();
  });

  it("counts coverage over in-scope components", () => {
    expect(stats(m)).toMatchObject({
      components: 3, inScope: 2, tested: 1, fixed: 1, plaintextFlows: 1,
      open: { critical: 0, high: 1, medium: 1, low: 0 },
    });
  });

  it("writes a findings table worst first", () => {
    const md = findingsMarkdown(m);
    expect(md.split("\n")[4]).toContain("| critical | API | y |");
  });
});

describe("toDrawioSpec", () => {
  it("keeps positions, summarises open findings and names plaintext flows", () => {
    const m = normalize({
      title: "Acme",
      nodes: [
        { id: "web", label: "Web server", kind: "service", findings: [{ title: "Debug on", severity: "high" }, { title: "Old TLS", severity: "high" }, { title: "x", severity: "low", status: "fixed" }] },
        { id: "db", label: "MySQL", kind: "datastore" },
        { id: "crm", label: "CRM", kind: "external", inScope: false },
      ],
      edges: [{ from: "web", to: "db", label: "SQL", encrypted: false }, { from: "web", to: "crm", label: "HTTPS", encrypted: true }],
    });
    const spec = toDrawioSpec(layout(m)) as { title: string; nodes: { id: string; sub: string; x: number; kind: string }[]; edges: { from: string; label?: string }[] };
    expect(spec.title).toBe("Acme");
    expect(spec.nodes.map((n) => n.sub)).toEqual(["2 high", "no open findings", "out of scope"]);
    expect(spec.nodes[0].x).toBe(40);
    expect(spec.nodes.map((n) => n.kind)).toEqual(["service", "datastore", "external"]);
    expect(spec.edges.map((e) => e.label)).toEqual(["SQL (plaintext)", "HTTPS"]);
    expect(new Set(spec.nodes.map((n) => n.id)).size).toBe(3);
    expect(spec.edges[0].from).toBe(spec.nodes[0].id);
  });
});

describe("buildBudget", () => {
  it("raises the limit for diagram files and respects the model's own cap", () => {
    expect(buildBudget(4096, false)).toBe(8192);
    expect(buildBudget(4096, true)).toBe(32768);
    expect(buildBudget(40000, true)).toBe(40000);
    expect(buildBudget(4096, true, 16000)).toBe(16000);
    expect(buildBudget(4096, true, null)).toBe(32768);
  });
});

describe("flows", () => {
  const raw = {
    title: "Flows",
    nodes: [{ id: "rot", label: "Root of trust" }, { id: "ver", label: "Verifier" }, { id: "host", label: "Host" }, { id: "bmc", label: "BMC" }],
    edges: [
      { from: "rot", to: "ver", label: "SPDM evidence", kind: "attestation", findings: [{ title: "Classical signature", severity: "high", ref: "CWE-327" }] },
      { from: "host", to: "rot", label: "rshim - blocked by Restricted mode" },
      { from: "ver", to: "bmc", label: "verdict (implied)", kind: "Policy" },
      { from: "bmc", to: "rot", label: "Redfish", kind: "mgmt", protocol: "Redfish/HTTPS", auth: "mTLS", encrypted: true },
      { from: "host", to: "ver", label: "legacy" },
    ],
  };

  it("reads kinds, flags and findings, with sensible defaults", () => {
    const m = normalize(raw);
    expect(m.edges.map((e) => e.kind)).toEqual(["attestation", "blocked", "control", "management", "data"]);
    expect(m.edges[2]).toMatchObject({ label: "verdict", implied: true });
    expect(m.edges[3]).toMatchObject({ protocol: "Redfish/HTTPS", auth: "mTLS", encrypted: true });
    expect(m.edges[0].findings).toEqual([expect.objectContaining({ title: "Classical signature", severity: "high", status: "open" })]);
    expect(m.edges[4]).toMatchObject({ kind: "data", findings: [] });
    expect(m.edges[4].implied).toBeUndefined();
    // a saved canvas opens again unchanged
    expect(normalize(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });

  it("counts flow findings and flow types in the summary and the findings table", () => {
    const m = normalize(raw);
    const s = stats(m);
    expect(s.open.high).toBe(1);
    expect(s).toMatchObject({ flows: 5, impliedFlows: 1, blockedFlows: 1 });
    expect(s.byKind).toMatchObject({ attestation: 1, blocked: 1, control: 1, management: 1, data: 1, identity: 0 });
    expect(findingsMarkdown(m)).toContain("| high | Root of trust → Verifier (attestation / evidence flow) | Classical signature |");
  });

  it("carries flow types into the draw.io export", () => {
    const spec = toDrawioSpec(layout(normalize(raw))) as { edges: { style: string; label?: string }[]; legend: unknown };
    expect(spec.edges.map((e) => e.style)).toEqual(["ai", "weak", "sync", "sync", "data"]);
    expect(spec.edges[0].label).toBe("attestation: SPDM evidence");
    expect(spec.edges[2].label).toBe("control: verdict (implied)");
    expect(spec.legend).toEqual({ edges: [] });
  });
});
