// The catalogues as text for system prompts. Each brief is compact (one line per entry) so a
// preset can carry several of them on every turn without crowding out the user's material.
import {
  ASVS_5, ATLAS_MITIGATIONS, ATLAS_TACTICS, OWASP_AGENTIC_2026, OWASP_API_2023, OWASP_LLM_2025, OWASP_MOBILE_2024,
  OWASP_TOP10_2025, STRIDE, STRIDE_BY_ELEMENT, WSTG_4_2, type Risk,
} from "./catalogues";

const risks = (title: string, list: Risk[], withFix = true) =>
  `${title}\n` + list.map((r) => `- ${r.id} ${r.name}: look for ${r.look}.${withFix ? ` Fix: ${r.fix}.` : ""}`).join("\n");

export const owaspTop10Brief = (withFix = true) => risks("OWASP Top 10:2025 (web applications):", OWASP_TOP10_2025, withFix);
export const owaspApiBrief = (withFix = true) => risks("OWASP API Security Top 10:2023:", OWASP_API_2023, withFix);
export const owaspLlmBrief = (withFix = true) => risks("OWASP Top 10 for LLM Applications 2025:", OWASP_LLM_2025, withFix);
export const owaspAgenticBrief = (withFix = true) => risks("OWASP Top 10 for Agentic Applications 2026:", OWASP_AGENTIC_2026, withFix);
export const owaspMobileBrief = (withFix = true) => risks("OWASP Mobile Top 10 2024:", OWASP_MOBILE_2024, withFix);

export const asvsBrief = () =>
  "OWASP ASVS 5.0 chapters (the requirements a control is verified against):\n" +
  ASVS_5.map((c) => `- ${c.id} ${c.name}: ${c.covers}`).join("\n");

export const wstgBrief = () =>
  "OWASP WSTG 4.2 test categories (the order a web test runs in):\n" +
  WSTG_4_2.map((c) => `- ${c.id} ${c.code} ${c.name}: ${c.tests}`).join("\n");

export const atlasBrief = () =>
  "MITRE ATLAS tactics and techniques (attacks on AI systems, ids AML.Txxxx; cite them for AI components):\n" +
  ATLAS_TACTICS.map((t) => `- ${t.id} ${t.name}: ${t.techniques.join("; ")}`).join("\n");

export const atlasMitigationsBrief = () =>
  "MITRE ATLAS mitigations (cite the id in a fix for an AI component):\n" +
  ATLAS_MITIGATIONS.map((m) => `${m.id} ${m.name}`).join("; ");

export const strideBrief = () =>
  "STRIDE, per element:\n" +
  STRIDE.map((s) => `- ${s.letter} ${s.name} (violates ${s.violates}): ${s.asks}`).join("\n") +
  "\nApplicable categories by element: " +
  Object.entries(STRIDE_BY_ELEMENT).map(([k, v]) => `${k} ${v}`).join(", ") + ".";

/** The severity scale every preset and the canvas use, so ratings mean the same thing everywhere. */
export const SEVERITY_RUBRIC = `Severity (rate by what an attacker gets, not by how clever the bug is):
- critical: unauthenticated, or any user, reaches other users' or regulated data, runs code, or takes over accounts or infrastructure; no mitigating control in the way.
- high: the same with one precondition (a low-privilege account, user interaction, an internal position), or a sensitive-data exposure at scale.
- medium: limited data or limited users, needs chaining or an unlikely precondition, or a missing defence-in-depth control that the threat model relies on.
- low: hygiene, information with no direct path to harm, or an issue needing an already-compromised position.
Business-critical data (regulated, financial, safety) raises a rating one step; a tested compensating control lowers it one step. Say which applied.`;

/** Rules shared by every security preset. */
export const SECURITY_BASELINE = `Working rules:
- Only assess systems the user owns or is authorised to test (engagements, labs, CTFs). Decline to help attack anything else, and say so briefly.
- Separate evidence from inference. Only report what the material shows; say what you assumed and what you could not check. Never invent components, findings or citations.
- Cite the reference for every finding: the OWASP id (A01:2025, API1:2023, LLM01:2025, ASI01:2026, M1:2024), the CWE, and for AI components the ATLAS technique (AML.Txxxx) and mitigation (AML.Mxxxx); ATT&CK ids (Txxxx) for adversary behaviour outside the AI system.
- Every finding carries a concrete fix a developer can act on, and the ASVS chapter it is verified against.
- Rate severity with the rubric below and show the reasoning in one line.
- Finish with a coverage line: which categories you considered and found nothing for, so silence is not mistaken for safety.`;

/** The whole catalogue, for a preset that wants everything (threat modelling, tabletop, CTF). */
export const fullBrief = () =>
  [owaspTop10Brief(), owaspApiBrief(), owaspLlmBrief(), owaspAgenticBrief(), owaspMobileBrief(false), asvsBrief(), atlasBrief(), atlasMitigationsBrief()].join("\n\n");

/** Compact: names only, for prompts that must stay small (the canvas builder). */
export const compactCoverage = () =>
  [
    `OWASP Top 10:2025: ${OWASP_TOP10_2025.map((r) => `${r.id} ${r.name}`).join("; ")}.`,
    `OWASP API Top 10:2023: ${OWASP_API_2023.map((r) => `${r.id} ${r.name}`).join("; ")}.`,
    `OWASP LLM Top 10 2025: ${OWASP_LLM_2025.map((r) => `${r.id} ${r.name}`).join("; ")}.`,
    `OWASP Agentic Top 10 2026: ${OWASP_AGENTIC_2026.map((r) => `${r.id} ${r.name}`).join("; ")}.`,
    `ATLAS tactics: ${ATLAS_TACTICS.map((t) => `${t.id} ${t.name}`).join("; ")}.`,
    `ATLAS techniques to cite on AI components: ${ATLAS_TACTICS.flatMap((t) => t.techniques).filter((s, i, a) => a.indexOf(s) === i).map((s) => s.replace(/ \(.*\)$/, "")).join("; ")}.`,
  ].join("\n");
