import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CANVAS_SYSTEM } from "../canvas/prompt";
import { PRESETS, FULL_INTEL_SYSTEM, presetFor } from "../presets";
import { atlasBrief, atlasMitigationsBrief, compactCoverage, fullBrief, owaspTop10Brief } from "./briefs";
import { CTF_CATEGORIES, CTF_FIRST_LOOK, ctfBrief } from "./ctf";
import {
  ASVS_5, ATLAS_MITIGATIONS, ATLAS_TACTICS, OWASP_AGENTIC_2026, OWASP_API_2023, OWASP_LLM_2025, OWASP_MOBILE_2024, OWASP_TOP10_2025,
  STRIDE, STRIDE_BY_ELEMENT, WSTG_4_2,
} from "./catalogues";

const ids = (list: { id: string }[]) => list.map((x) => x.id);
const unique = (xs: string[]) => new Set(xs).size === xs.length;

describe("catalogues", () => {
  it("hold the published lists in full, with unique ids", () => {
    for (const [name, list, n] of [
      ["OWASP Top 10:2025", OWASP_TOP10_2025, 10], ["API Top 10:2023", OWASP_API_2023, 10], ["LLM Top 10 2025", OWASP_LLM_2025, 10],
      ["Agentic Top 10 2026", OWASP_AGENTIC_2026, 10], ["Mobile Top 10 2024", OWASP_MOBILE_2024, 10], ["ASVS 5.0", ASVS_5, 17],
      ["WSTG 4.2", WSTG_4_2, 12], ["ATLAS tactics", ATLAS_TACTICS, 16], ["ATLAS mitigations", ATLAS_MITIGATIONS, 35],
    ] as const) {
      expect(list.length, name).toBe(n);
      expect(unique(ids([...list] as { id: string }[])), `${name} ids unique`).toBe(true);
    }
    expect(STRIDE.map((s) => s.letter).join("")).toBe("STRIDE");
    expect(ids(OWASP_TOP10_2025)).toEqual(Array.from({ length: 10 }, (_, i) => `A${String(i + 1).padStart(2, "0")}:2025`));
    expect(ids(OWASP_LLM_2025)).toEqual(Array.from({ length: 10 }, (_, i) => `LLM${String(i + 1).padStart(2, "0")}:2025`));
    expect(ids(OWASP_AGENTIC_2026)).toEqual(Array.from({ length: 10 }, (_, i) => `ASI${String(i + 1).padStart(2, "0")}:2026`));
    expect(ids(ATLAS_MITIGATIONS)).toEqual(Array.from({ length: 35 }, (_, i) => `AML.M${String(i).padStart(4, "0")}`));
  });

  it("every risk says what to look for and what fixes it", () => {
    for (const r of [...OWASP_TOP10_2025, ...OWASP_API_2023, ...OWASP_LLM_2025, ...OWASP_AGENTIC_2026, ...OWASP_MOBILE_2024]) {
      expect(r.look.length, r.id).toBeGreaterThan(20);
      expect(r.fix.length, r.id).toBeGreaterThan(15);
    }
  });

  it("ATLAS techniques are well-formed and cover the agent and LLM techniques", () => {
    const all = ATLAS_TACTICS.flatMap((t) => t.techniques);
    for (const t of all) expect(t, t).toMatch(/^AML\.T\d{4} \S/);
    const text = all.join(" ");
    for (const must of ["AML.T0051", "AML.T0054", "AML.T0053", "AML.T0056", "AML.T0057", "AML.T0070", "AML.T0080", "AML.T0086", "AML.T0010", "AML.T0043", "AML.T0024"]) {
      expect(text, must).toContain(must);
    }
    expect(STRIDE_BY_ELEMENT.ai).toBe("STRIDE");
  });
});

describe("briefs", () => {
  it("carry every id of the list they describe", () => {
    const full = fullBrief();
    for (const list of [OWASP_TOP10_2025, OWASP_API_2023, OWASP_LLM_2025, OWASP_AGENTIC_2026, OWASP_MOBILE_2024, ASVS_5, ATLAS_TACTICS, ATLAS_MITIGATIONS]) {
      for (const { id } of list) expect(full, id).toContain(id);
    }
    expect(owaspTop10Brief()).toContain("Fix:");
    expect(owaspTop10Brief(false)).not.toContain("Fix:");
    expect(atlasMitigationsBrief()).toContain("AML.M0029 Human In-the-Loop");
    for (const t of ATLAS_TACTICS) expect(atlasBrief()).toContain(`${t.id} ${t.name}`);
  });

  it("stay within a size a 32k-context model can carry on every turn", () => {
    expect(fullBrief().length).toBeLessThan(24_000);
    expect(compactCoverage().length).toBeLessThan(8_000);
  });
});

describe("presets", () => {
  it("have unique ids, rules, a severity rubric and starters, and match by system prompt", () => {
    expect(unique(ids(PRESETS))).toBe(true);
    for (const p of PRESETS) {
      expect(p.starters.length, p.id).toBeGreaterThan(2);
      expect(p.system.length, p.id).toBeLessThan(30_000);
      if (p.id !== "draw") {
        expect(p.system, p.id).toContain("Working rules:");
        expect(p.system, p.id).toContain("Severity (rate by");
      }
      expect(presetFor(p.system)?.id).toBe(p.id);
    }
    expect(presetFor("something else")).toBeUndefined();
  });

  it("put the right catalogue in front of each role", () => {
    const by = Object.fromEntries(PRESETS.map((p) => [p.id, p.system]));
    expect(by["threat-model"]).toContain("A01:2025");
    expect(by["threat-model"]).toContain("AML.TA0005 Execution");
    expect(by["threat-model"]).toContain("STRIDE, per element");
    expect(by["ai-review"]).toContain("LLM01:2025");
    expect(by["ai-review"]).toContain("ASI01:2026");
    expect(by["ai-review"]).toContain("AML.M0030");
    expect(by["pentest-plan"]).toContain("WSTG-INPV");
    expect(by["tabletop"]).toContain("master scenario events list");
    expect(by["tabletop"]).toContain("AML.TA0010 Exfiltration");
    expect(by["ctf"]).toContain("not by handing over the flag");
    expect(by["code-review"]).toContain("V8 Authorization");
    expect(by["logs"]).toContain("AML.T0051");
    expect(FULL_INTEL_SYSTEM).toContain("M1:2024");
    expect(FULL_INTEL_SYSTEM).toContain("V17 WebRTC");
  });
});

describe("CTF playbook", () => {
  it("covers the usual categories with first steps, families, tools, stuck questions and refs", () => {
    expect(CTF_CATEGORIES.map((c) => c.id)).toEqual(["web", "api", "crypto", "forensics", "reverse", "pwn", "osint", "cloud", "ai", "misc"]);
    for (const c of CTF_CATEGORIES) {
      expect(c.first.length, c.id).toBeGreaterThan(1);
      expect(c.families.length, c.id).toBeGreaterThan(0);
      expect(c.tools.length, c.id).toBeGreaterThan(0);
      expect(c.stuck.length, c.id).toBeGreaterThan(2);
      expect(c.refs.length, c.id).toBeGreaterThan(10);
    }
    const ai = CTF_CATEGORIES.find((c) => c.id === "ai")!;
    for (const t of ["AML.T0051", "AML.T0054", "AML.T0056", "AML.T0070", "AML.T0077", "AML.T0080"]) expect(ai.families.join(" "), t).toContain(t);
    const brief = ctfBrief();
    expect(brief).toContain(CTF_FIRST_LOOK);
    for (const c of CTF_CATEGORIES) expect(brief).toContain(`${c.name} (${c.id}):`);
    expect(brief.length).toBeLessThan(16_000);
    expect(PRESETS.find((p) => p.id === "ctf")!.system).toContain("First look, for any challenge");
  });
});

describe("canvas prompt", () => {
  it("knows the ai kind, the severity rubric, STRIDE and the compact coverage", () => {
    expect(CANVAS_SYSTEM).toContain('"ai"');
    expect(CANVAS_SYSTEM).toContain("Severity (rate by");
    expect(CANVAS_SYSTEM).toContain("STRIDE, per element");
    expect(CANVAS_SYSTEM).toContain("LLM01:2025 Prompt Injection");
    expect(CANVAS_SYSTEM).toContain("AML.TA0004 Initial Access");
    expect(CANVAS_SYSTEM).toContain("AML.T0051 LLM Prompt Injection");
    expect(CANVAS_SYSTEM).toContain("ONE JSON object");
    expect(CANVAS_SYSTEM.length).toBeLessThan(14_000);
  });
});

describe("the agent's instructions", () => {
  // docker/agent-AGENTS.md is what OpenCode loads into every Runner session; it cannot import
  // the catalogue, so this keeps it from drifting: every top-level id must be named there.
  const md = fs.readFileSync(path.join(__dirname, "..", "..", "..", "docker", "agent-AGENTS.md"), "utf8");
  it("name every OWASP category, ATLAS tactic and WSTG category", () => {
    for (const list of [OWASP_TOP10_2025, OWASP_API_2023, OWASP_LLM_2025, OWASP_AGENTIC_2026]) {
      for (const { id } of list) expect(md, id).toContain(id);
    }
    for (const t of ATLAS_TACTICS) expect(md, t.id).toContain(t.id);
    for (const c of WSTG_4_2) expect(md, c.code).toContain(c.code);
    for (const c of ASVS_5) expect(md, c.id).toMatch(new RegExp(`\\b${c.id}\\s+${c.name.split(" ")[0]}`));
  });
  it("carry the CTF first look and the tools the image ships", () => {
    expect(md).toContain("## CTF challenges and labs");
    for (const tool of ["`file`", "`strings -n 8`", "`exiftool`", "`binwalk`", "`tshark`", "`john`", "`gdb`", "`pwntools`", "`sqlmap`", "/workspace/.tools"]) expect(md, tool).toContain(tool);
    const dockerfile = fs.readFileSync(path.join(__dirname, "..", "..", "..", "docker", "agent.Dockerfile"), "utf8");
    for (const pkg of ["binwalk", "libimage-exiftool-perl", "tshark", "john", "gdb", "python3-pwntools", "sqlmap", "steghide"]) expect(dockerfile, pkg).toContain(pkg);
  });
});
