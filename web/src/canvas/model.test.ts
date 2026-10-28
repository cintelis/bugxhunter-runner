import { describe, expect, it } from "vitest";
import { extractJson, findingsMarkdown, layout, normalize, stats, toDrawioSpec, worstOpen } from "./model";

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
    expect(m.edges).toEqual([{ id: "e1", from: "web", to: "database", label: "MySQL :3306", encrypted: false }]);
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
    expect(stats(m)).toEqual({
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
