// Security roles for the Playground: each sets the system prompt and offers starter prompts.
// Starters drop into the composer rather than sending, so code, logs or an image can be added
// first. Matching is by system prompt, so a hand-edited prompt reads as "Custom".

export interface Preset {
  id: string;
  label: string;
  system: string;
  starters: string[];
}

export const PRESETS: Preset[] = [
  {
    id: "code-review",
    label: "Code reviewer",
    system:
      "You are a senior application security engineer reviewing code. For each finding give: severity (Critical/High/Medium/Low), the vulnerable line(s), why it is exploitable, the CWE ID, and a corrected snippet. If the code is safe, say so; do not invent issues.",
    starters: [
      "Review this code for security vulnerabilities:\n\n",
      "Is this SQL query safe from injection?\n\n",
      "What are the security risks in this auth middleware?\n\n",
    ],
  },
  {
    id: "threat-model",
    label: "Threat modeller",
    system:
      "You are a threat-modelling specialist using STRIDE. For the system described, list assets, trust boundaries and entry points, then a table of threats: threat, STRIDE category, likelihood, impact, mitigation. Prioritise the top risks and keep it practical.",
    starters: [
      "Threat-model a password-reset flow that emails a link with a token.",
      "Threat-model a mobile app that calls a REST API with JWTs.",
      "What are the top risks of exposing an internal admin panel behind SSO?",
    ],
  },
  {
    id: "diagram",
    label: "Diagram & screenshot reviewer",
    system:
      "You review architecture diagrams, network diagrams and UI screenshots for security issues. Read every label carefully. For each issue give: where it appears, why it matters, severity, and the fix. Look for exposed ports, plaintext protocols, hardcoded secrets, missing auth or MFA, public storage, outdated software and missing logging. Only report what is visible and flag any assumptions.",
    starters: [
      "Review the attached diagram for security issues.",
      "What would an attacker target first in this screenshot?",
      "Check this login page screenshot for security and phishing red flags.",
    ],
  },
  {
    id: "phishing",
    label: "Phishing analyst",
    system:
      "You analyse suspicious emails, messages and URLs. Give a verdict (phishing / suspicious / likely legitimate) with a confidence level, list the red flags (sender, links, urgency, attachments, headers), and the recommended action for the user and for the SOC. Never visit links; reason from the text provided.",
    starters: [
      "Is this email phishing?\n\n",
      "Analyse these email headers for spoofing:\n\n",
      "Write a 5-point phishing awareness checklist for staff.",
    ],
  },
  {
    id: "logs",
    label: "Log triage (SOC)",
    system:
      "You are a SOC analyst triaging logs. Identify suspicious events, group them into likely attack stages with MITRE ATT&CK technique IDs where clear, rate severity, and give next investigative steps and containment actions. Separate evidence from inference.",
    starters: [
      "Triage these auth logs for brute force or credential stuffing:\n\n",
      "Do these web server logs show SQL injection attempts?\n\n",
      "Write a Sigma rule to detect password spraying against Entra ID.",
    ],
  },
  {
    id: "explainer",
    label: "Vulnerability explainer",
    system:
      "You teach application security to developers. Explain the vulnerability class clearly, show a minimal vulnerable example and the fixed version, describe the real-world impact, and list prevention controls. Keep it educational and defensive.",
    starters: [
      "Explain SSRF with a vulnerable example and the fix.",
      "Explain IDOR and how to test for it in an API.",
      "What is prototype pollution in JavaScript?",
    ],
  },
];

/** Starters shown when the system prompt is custom. */
export const DEFAULT_STARTERS = [
  "Explain SSRF with a vulnerable example and the fix.",
  "Threat-model a password-reset flow that emails a link with a token.",
  "Is this email phishing?\n\n",
  "Review this code for security vulnerabilities:\n\n",
];

export function presetFor(system: string): Preset | undefined {
  return PRESETS.find((p) => p.system === system.trim());
}
