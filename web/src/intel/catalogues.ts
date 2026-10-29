// The defensive knowledge the Playground, the canvas and the agent reason with: OWASP's lists
// and verification standard, and MITRE ATLAS for attacks on AI systems. Kept as data so that
// prompts are built from one source, tests can check nothing is missing, and an edition bump
// is one edit. Every entry says what to look for and what fixes it, in one line each, because
// the text goes into system prompts on every turn.
//
// Sources, as read on 29 October 2026:
//   OWASP Top 10:2025                       https://top10.owasp.org/2025
//   OWASP API Security Top 10:2023          https://api-security.owasp.org/editions/2023/en/0x11-t10
//   OWASP Top 10 for LLM Applications 2025  https://genai.owasp.org/llm-top-10/
//   OWASP Top 10 for Agentic Applications 2026 (ASI) https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/
//   OWASP Mobile Top 10 2024                https://owasp.org/www-project-mobile-top-10/
//   OWASP ASVS 5.0 chapters                 https://github.com/OWASP/ASVS/tree/master/5.0/en
//   OWASP WSTG 4.2 categories               https://wstg.owasp.org
//   MITRE ATLAS (atlas-data 5.x)            https://atlas.mitre.org, https://github.com/mitre-atlas/atlas-data

export interface Risk {
  id: string;
  name: string;
  /** What to look for: the signs of it, in one line. */
  look: string;
  /** The control that removes it, in one line. */
  fix: string;
  /** STRIDE letters this risk mostly realises (S T R I D E). */
  stride?: string;
}

export const OWASP_TOP10_2025: Risk[] = [
  { id: "A01:2025", name: "Broken Access Control", stride: "E",
    look: "object or function reachable by changing an id, role or URL; missing checks server-side; CORS, path traversal, IDOR, forced browsing, JWT or cookie tampering",
    fix: "deny by default, enforce ownership and role on the server for every object and function, log failures, rate-limit automation" },
  { id: "A02:2025", name: "Security Misconfiguration", stride: "I",
    look: "defaults left on, debug or admin interfaces exposed, verbose errors, permissive cloud storage, missing hardening headers, unneeded features and ports",
    fix: "hardened repeatable builds, minimal platform, configuration review per environment, automated drift checks" },
  { id: "A03:2025", name: "Software Supply Chain Failures", stride: "T",
    look: "unpinned or unverified dependencies, build and CI steps that can be tampered with, packages from untrusted registries, no SBOM, unsigned artifacts",
    fix: "pin and verify dependencies, signed builds with provenance, SBOM, dependency and container scanning, least privilege for CI tokens" },
  { id: "A04:2025", name: "Cryptographic Failures", stride: "I",
    look: "plaintext or weak transport, secrets or PII stored unencrypted, weak algorithms or key sizes, home-made crypto, keys in code, poor randomness",
    fix: "TLS everywhere, modern algorithms (AES-256-GCM, SHA-256+, Argon2 or bcrypt for passwords), key management, encrypt data at rest, no custom crypto" },
  { id: "A05:2025", name: "Injection", stride: "T",
    look: "user input reaching SQL, NoSQL, OS commands, LDAP, templates, XPath or HTML without separation; string-built queries; reflected or stored script",
    fix: "parameterised queries and safe APIs, allow-list validation, contextual output encoding, CSP, no shell from input" },
  { id: "A06:2025", name: "Insecure Design", stride: "STRIDE",
    look: "missing threat model, business-logic abuse (replay, race, quota bypass), trust placed in the client, recovery flows that leak or bypass, no abuse cases",
    fix: "threat modelling in design, secure design patterns and reference architectures, abuse-case tests, limits on business flows" },
  { id: "A07:2025", name: "Authentication Failures", stride: "S",
    look: "credential stuffing and brute force possible, weak or default passwords, no MFA on sensitive actions, session ids in URLs, sessions not rotated or expired, weak recovery",
    fix: "MFA, breached-password checks, rate limits and lockout, server-side session management with rotation and expiry, secure recovery" },
  { id: "A08:2025", name: "Software or Data Integrity Failures", stride: "T",
    look: "unsigned updates and plugins, insecure deserialisation, CI pipelines or auto-update channels that trust unverified input, integrity of data in transit between services unchecked",
    fix: "signatures and verification for code, updates and serialised data; integrity checks in pipelines; no deserialisation of untrusted input" },
  { id: "A09:2025", name: "Security Logging and Alerting Failures", stride: "R",
    look: "logins, access failures and high-value actions not logged, logs without context or integrity, no alerting, no response plan, logs that leak secrets",
    fix: "log auth and authorisation events with user and time, protect log integrity, alert on patterns, test the response playbook" },
  { id: "A10:2025", name: "Mishandling of Exceptional Conditions", stride: "D",
    look: "errors that fail open, unhandled exceptions, resource exhaustion, retries without limits, partial failures that leave state inconsistent, error messages with internals",
    fix: "fail closed, handle every error path, timeouts and limits, idempotent operations, generic errors to users with detail in logs" },
];

export const OWASP_API_2023: Risk[] = [
  { id: "API1:2023", name: "Broken Object Level Authorization", stride: "E", look: "endpoints that take an object id and never check the caller owns it", fix: "authorise every object access against the session's identity; random ids are not a control" },
  { id: "API2:2023", name: "Broken Authentication", stride: "S", look: "weak tokens, no expiry or rotation, credentials in URLs, unauthenticated sensitive endpoints, auth that differs between API versions", fix: "standard, tested auth on every endpoint; short-lived tokens; MFA for sensitive flows" },
  { id: "API3:2023", name: "Broken Object Property Level Authorization", stride: "I", look: "responses that return more fields than the client needs; mass assignment of fields the user may not set", fix: "explicit response schemas and allow-lists for writable properties" },
  { id: "API4:2023", name: "Unrestricted Resource Consumption", stride: "D", look: "no limits on request rate, payload size, pagination, uploads or paid third-party calls", fix: "rate limits, quotas, size and pagination caps, spend limits on paid services" },
  { id: "API5:2023", name: "Broken Function Level Authorization", stride: "E", look: "admin or privileged functions reachable by guessing the route or changing the method", fix: "deny by default, role checks on every function, one authorisation module" },
  { id: "API6:2023", name: "Unrestricted Access to Sensitive Business Flows", stride: "D", look: "flows like purchase, signup, voting or booking callable at scale by scripts", fix: "detect and slow automation: device fingerprinting, step-up, human checks, business limits" },
  { id: "API7:2023", name: "Server Side Request Forgery", stride: "I", look: "the API fetches a URL the client supplies: webhooks, imports, previews, image fetchers", fix: "allow-list destinations, block internal ranges and metadata endpoints, no redirects, isolated fetcher" },
  { id: "API8:2023", name: "Security Misconfiguration", stride: "I", look: "missing TLS, permissive CORS, verbose errors, unneeded HTTP methods, unpatched components", fix: "hardening baseline, automated configuration checks, patching" },
  { id: "API9:2023", name: "Improper Inventory Management", stride: "I", look: "old API versions, debug or staging endpoints still live, undocumented hosts and data flows", fix: "inventory of hosts, versions and data flows; retire old versions; document data sharing" },
  { id: "API10:2023", name: "Unsafe Consumption of APIs", stride: "T", look: "data from third-party APIs trusted without validation, followed redirects, unencrypted upstream calls", fix: "validate and limit upstream responses, TLS to upstreams, timeouts, no blind redirects" },
];

export const OWASP_LLM_2025: Risk[] = [
  { id: "LLM01:2025", name: "Prompt Injection", stride: "T", look: "user or retrieved content changes the model's instructions; indirect injection through documents, web pages, tool results, emails", fix: "treat all model input as untrusted, separate instructions from data, constrain output format, least privilege for what the model can trigger, human approval for consequential actions" },
  { id: "LLM02:2025", name: "Sensitive Information Disclosure", stride: "I", look: "secrets, PII or system details in training data, context or outputs; model repeats what one user told it to another", fix: "scrub data, scope context per user, output filtering, no secrets in prompts" },
  { id: "LLM03:2025", name: "Supply Chain", stride: "T", look: "third-party models, adapters, datasets, plugins or packages with no provenance; pickled or unsigned model files", fix: "verified sources, signed artifacts, AI bill of materials, scan model files, pin versions" },
  { id: "LLM04:2025", name: "Data and Model Poisoning", stride: "T", look: "training, fine-tuning or embedding data that an outsider can influence; backdoor triggers", fix: "dataset provenance and validation, anomaly checks, hold-out evaluation, sandbox fine-tuning" },
  { id: "LLM05:2025", name: "Improper Output Handling", stride: "T", look: "model output rendered as HTML, executed as code or SQL, or passed to a shell or another API without validation", fix: "treat output as untrusted input: encode, validate, parameterise, sandbox execution" },
  { id: "LLM06:2025", name: "Excessive Agency", stride: "E", look: "tools and permissions beyond the task, autonomous actions with no approval, one credential for every tool", fix: "minimal tools and scopes, per-action authorisation, human in the loop for consequential actions, kill switch" },
  { id: "LLM07:2025", name: "System Prompt Leakage", stride: "I", look: "system prompt holds secrets, roles or rules the security depends on; it can be extracted by asking", fix: "no secrets or security decisions in prompts; enforce rules outside the model" },
  { id: "LLM08:2025", name: "Vector and Embedding Weaknesses", stride: "I", look: "shared vector store across tenants, poisoned or stale documents, embedding inversion, retrieval of restricted documents", fix: "per-tenant and per-user access control on retrieval, validate sources, monitor retrieved content" },
  { id: "LLM09:2025", name: "Misinformation", stride: "R", look: "hallucinated facts, packages or citations acted on without checking; over-reliance in decisions", fix: "grounding with retrieval, verification steps, human review for decisions, communicate uncertainty" },
  { id: "LLM10:2025", name: "Unbounded Consumption", stride: "D", look: "no limits on tokens, requests, recursion or cost; model extraction through many queries", fix: "rate and spend limits, input size caps, timeouts, query monitoring, watermark or limit API detail" },
];

export const OWASP_AGENTIC_2026: Risk[] = [
  { id: "ASI01:2026", name: "Agent Goal Hijack", stride: "T", look: "content the agent reads (pages, files, tool results, other agents) redirects what it is trying to do", fix: "isolate instructions from data, verify intent before acting, constrain plans to the task" },
  { id: "ASI02:2026", name: "Tool Misuse and Exploitation", stride: "E", look: "permitted tools used in loops, unsafe chains or at runaway volume; tool parameters from untrusted text", fix: "least-agency tool scoping, parameter validation, budgets and loop limits, approval for risky tools" },
  { id: "ASI03:2026", name: "Identity and Privilege Abuse", stride: "S", look: "agent acts with a human's or a service's broad credential; delegation with no bound identity or scope", fix: "per-agent identity, short-lived scoped tokens, delegation that carries the principal and the task" },
  { id: "ASI04:2026", name: "Agentic Supply Chain Vulnerabilities", stride: "T", look: "imported tools, MCP servers, schemas, prompts or other agents trusted without verification", fix: "verify and pin tool and agent sources, review tool definitions, sandbox third-party tools" },
  { id: "ASI05:2026", name: "Unexpected Code Execution", stride: "E", look: "generated code or commands run without validation or isolation; interpreters reachable from prompts", fix: "sandboxed execution, allow-listed commands, review before run, no shell from model text" },
  { id: "ASI06:2026", name: "Memory and Context Poisoning", stride: "T", look: "injected or leaked memory, notes or thread context keeps steering later runs", fix: "validate what is written to memory, scope memory per user and task, expiry, review of persistent context" },
  { id: "ASI07:2026", name: "Insecure Inter-Agent Communication", stride: "S", look: "messages between agents can be read, forged or altered; no authentication between agents", fix: "authenticated, integrity-protected channels; schemas; treat other agents' output as untrusted" },
  { id: "ASI08:2026", name: "Cascading Failures", stride: "D", look: "one bad output or outage propagates through chained tools and agents; no circuit breakers", fix: "isolation boundaries, timeouts, circuit breakers, idempotent actions, rollback" },
  { id: "ASI09:2026", name: "Human-Agent Trust Exploitation", stride: "R", look: "confident agent output accepted without verification; approvals rubber-stamped; UI that hides what the agent did", fix: "show evidence and provenance, require review for consequential actions, measure override rates" },
  { id: "ASI10:2026", name: "Rogue Agents", stride: "E", look: "agents acting outside their intended behaviour or scope, surviving beyond their task, no way to stop them", fix: "kill switch, task-bound lifetimes, monitoring of actions against policy, audit trail" },
];

export const OWASP_MOBILE_2024: Risk[] = [
  { id: "M1:2024", name: "Improper Credential Usage", look: "hardcoded keys, credentials stored or transmitted insecurely", fix: "no secrets in the app, platform keystores, short-lived tokens" },
  { id: "M2:2024", name: "Inadequate Supply Chain Security", look: "unverified SDKs and libraries, compromised build", fix: "vetted dependencies, signed builds, integrity checks" },
  { id: "M3:2024", name: "Insecure Authentication/Authorization", look: "client-side auth decisions, weak session handling, missing server checks", fix: "server-side authorisation, MFA, secure session tokens" },
  { id: "M4:2024", name: "Insufficient Input/Output Validation", look: "injection via deep links, intents, WebViews, file inputs", fix: "validate and encode at every boundary, restrict WebView bridges" },
  { id: "M5:2024", name: "Insecure Communication", look: "plaintext or weakly validated TLS, no pinning where warranted", fix: "TLS with validation, pinning for high-value apps" },
  { id: "M6:2024", name: "Inadequate Privacy Controls", look: "over-collection, PII in logs, leakage to third parties", fix: "data minimisation, consent, scrub logs" },
  { id: "M7:2024", name: "Insufficient Binary Protections", look: "easy reverse engineering and tampering of the binary", fix: "obfuscation and integrity checks where the threat model needs them; keep secrets off the device" },
  { id: "M8:2024", name: "Security Misconfiguration", look: "debug flags, exported components, permissive permissions", fix: "hardened release config, minimal permissions" },
  { id: "M9:2024", name: "Insecure Data Storage", look: "sensitive data in plain files, caches, backups, clipboard", fix: "platform secure storage, encryption, exclude from backups" },
  { id: "M10:2024", name: "Insufficient Cryptography", look: "weak algorithms, poor key handling, custom crypto", fix: "platform crypto APIs, modern algorithms, key management" },
];

export interface Chapter { id: string; name: string; covers: string }

export const ASVS_5: Chapter[] = [
  { id: "V1", name: "Encoding and Sanitization", covers: "injection prevention, output encoding, sanitisation of HTML, SQL, OS, templates" },
  { id: "V2", name: "Validation and Business Logic", covers: "input validation, business-logic limits, anti-automation, sequence and timing" },
  { id: "V3", name: "Web Frontend Security", covers: "browser security headers, CSP, cookies, CORS, clickjacking" },
  { id: "V4", name: "API and Web Service", covers: "REST, GraphQL, WebSocket, schema validation, HTTP method handling" },
  { id: "V5", name: "File Handling", covers: "uploads, downloads, path traversal, file type and size limits, storage" },
  { id: "V6", name: "Authentication", covers: "passwords, MFA, credential recovery, lookup secrets, out-of-band, rate limits" },
  { id: "V7", name: "Session Management", covers: "session ids, binding, timeout, logout, re-authentication, cookie attributes" },
  { id: "V8", name: "Authorization", covers: "object, function and field-level authorisation, ownership, admin interfaces" },
  { id: "V9", name: "Self-contained Tokens", covers: "JWT and similar: signature, algorithm, audience, expiry, revocation" },
  { id: "V10", name: "OAuth and OIDC", covers: "flows, PKCE, redirect validation, token handling, client registration" },
  { id: "V11", name: "Cryptography", covers: "algorithms, key management, randomness, password hashing, crypto agility" },
  { id: "V12", name: "Secure Communication", covers: "TLS configuration, certificate validation, internal service encryption" },
  { id: "V13", name: "Configuration", covers: "secrets management, dependencies, unneeded features, secure defaults, build integrity" },
  { id: "V14", name: "Data Protection", covers: "classification, encryption at rest, minimisation, caching, data in logs and backups" },
  { id: "V15", name: "Secure Coding and Architecture", covers: "threat modelling, trust boundaries, defensive coding, memory safety, concurrency" },
  { id: "V16", name: "Security Logging and Error Handling", covers: "what to log, log protection, error handling that fails closed" },
  { id: "V17", name: "WebRTC", covers: "media and signalling security, TURN, DoS resistance" },
];

export interface TestCategory { id: string; code: string; name: string; tests: string }

export const WSTG_4_2: TestCategory[] = [
  { id: "4.1", code: "WSTG-INFO", name: "Information Gathering", tests: "search engine and metadata leakage, fingerprint server and framework, enumerate applications and entry points, map architecture and execution paths" },
  { id: "4.2", code: "WSTG-CONF", name: "Configuration and Deployment Management", tests: "platform and framework configuration, file extensions and backups, admin interfaces, HTTP methods, HSTS, cloud storage, subdomain takeover, path confusion" },
  { id: "4.3", code: "WSTG-IDNT", name: "Identity Management", tests: "role definitions, registration and provisioning, account enumeration, username policy" },
  { id: "4.4", code: "WSTG-ATHN", name: "Authentication", tests: "credentials over encrypted channel, default credentials, lockout, bypass, remember-me, cache, password policy and reset, MFA" },
  { id: "4.5", code: "WSTG-ATHZ", name: "Authorization", tests: "directory traversal and file include, authorisation bypass, privilege escalation, IDOR, OAuth" },
  { id: "4.6", code: "WSTG-SESS", name: "Session Management", tests: "session schema, cookie attributes, fixation, exposed variables, CSRF, logout, timeout, puzzling, hijacking, JWT" },
  { id: "4.7", code: "WSTG-INPV", name: "Injection", tests: "reflected and stored XSS, HTTP verb and parameter tampering, SQL, LDAP, XML, SSI, XPath, IMAP/SMTP, code, command, format string, buffer, HTTP splitting, request smuggling, SSRF, mass assignment" },
  { id: "4.8", code: "WSTG-ERRH", name: "Error Handling", tests: "improper error handling, stack traces" },
  { id: "4.9", code: "WSTG-CRYP", name: "Weak Cryptography", tests: "TLS, padding oracle, sensitive data over unencrypted channels, weak encryption" },
  { id: "4.10", code: "WSTG-BUSL", name: "Business Logic", tests: "data validation, request forgery, integrity checks, process timing, function limits, workflow circumvention, defences against misuse, unexpected file types, malicious file upload, payment functionality" },
  { id: "4.11", code: "WSTG-CLNT", name: "Client-side", tests: "DOM XSS, JavaScript execution, HTML and CSS injection, client-side redirect, resource manipulation, CORS, cross-site flashing, clickjacking, WebSockets, web messaging, browser storage, script inclusion, reverse tabnabbing" },
  { id: "4.12", code: "WSTG-APIT", name: "API Testing", tests: "GraphQL (introspection, batching, injection), API reconnaissance, broken object-level authorisation" },
];

export interface AtlasTactic { id: string; name: string; techniques: string[] }

/** ATLAS tactics in matrix order with their techniques (id and name), sub-techniques where they matter. */
export const ATLAS_TACTICS: AtlasTactic[] = [
  { id: "AML.TA0002", name: "Reconnaissance", techniques: [
    "AML.T0000 Search Open Technical Databases", "AML.T0001 Search Open AI Vulnerability Analysis", "AML.T0003 Search Victim-Owned Websites",
    "AML.T0004 Search Application Repositories", "AML.T0006 Active Scanning", "AML.T0064 Gather RAG-Indexed Targets",
    "AML.T0087 Gather Victim Identity Information", "AML.T0095 Search Open Websites/Domains" ] },
  { id: "AML.TA0003", name: "Resource Development", techniques: [
    "AML.T0002 Acquire Public AI Artifacts", "AML.T0008 Acquire Infrastructure", "AML.T0016 Obtain Capabilities", "AML.T0017 Develop Capabilities",
    "AML.T0019 Publish Poisoned Datasets", "AML.T0020 Poison Training Data", "AML.T0021 Establish Accounts", "AML.T0058 Publish Poisoned Models",
    "AML.T0060 Publish Hallucinated Entities", "AML.T0065 LLM Prompt Crafting", "AML.T0066 Retrieval Content Crafting", "AML.T0079 Stage Capabilities",
    "AML.T0104 Publish Poisoned AI Agent Tool" ] },
  { id: "AML.TA0004", name: "Initial Access", techniques: [
    "AML.T0010 AI Supply Chain Compromise (hardware, AI software, data, model, container registry, AI agent tool)", "AML.T0012 Valid Accounts",
    "AML.T0015 Evade AI Model", "AML.T0049 Exploit Public-Facing Application", "AML.T0052 Phishing (LLM-written spearphishing, deepfake-assisted)",
    "AML.T0078 Drive-by Compromise", "AML.T0093 Prompt Infiltration via Public-Facing Application" ] },
  { id: "AML.TA0000", name: "AI Model Access", techniques: [
    "AML.T0040 AI Model Inference API Access", "AML.T0041 Physical Environment Access", "AML.T0044 Full AI Model Access", "AML.T0047 AI-Enabled Product or Service" ] },
  { id: "AML.TA0005", name: "Execution", techniques: [
    "AML.T0011 User Execution (unsafe AI artifacts, malicious package, poisoned AI agent tool, malicious link)", "AML.T0050 Command and Scripting Interpreter",
    "AML.T0051 LLM Prompt Injection (AML.T0051.000 direct, AML.T0051.001 indirect, AML.T0051.002 triggered)", "AML.T0053 AI Agent Tool Invocation",
    "AML.T0100 AI Agent Clickbait", "AML.T0103 Deploy AI Agent" ] },
  { id: "AML.TA0006", name: "Persistence", techniques: [
    "AML.T0018 Manipulate AI Model (poison, modify architecture, embed malware)", "AML.T0020 Poison Training Data", "AML.T0061 LLM Prompt Self-Replication",
    "AML.T0070 RAG Poisoning", "AML.T0080 AI Agent Context Poisoning (memory, thread)", "AML.T0081 Modify AI Agent Configuration",
    "AML.T0093 Prompt Infiltration via Public-Facing Application", "AML.T0099 AI Agent Tool Data Poisoning", "AML.T0110 AI Agent Tool Poisoning" ] },
  { id: "AML.TA0012", name: "Privilege Escalation", techniques: [
    "AML.T0012 Valid Accounts", "AML.T0053 AI Agent Tool Invocation", "AML.T0054 LLM Jailbreak", "AML.T0105 Escape to Host" ] },
  { id: "AML.TA0007", name: "Defense Evasion", techniques: [
    "AML.T0015 Evade AI Model", "AML.T0054 LLM Jailbreak", "AML.T0067 LLM Trusted Output Components Manipulation (citations)", "AML.T0068 LLM Prompt Obfuscation",
    "AML.T0071 False RAG Entry Injection", "AML.T0073 Impersonation", "AML.T0074 Masquerading", "AML.T0076 Corrupt AI Model", "AML.T0081 Modify AI Agent Configuration",
    "AML.T0092 Manipulate User LLM Chat History", "AML.T0094 Delay Execution of LLM Instructions", "AML.T0097 Virtualization/Sandbox Evasion",
    "AML.T0107 Exploitation for Defense Evasion", "AML.T0109 AI Supply Chain Rug Pull", "AML.T0111 AI Supply Chain Reputation Inflation" ] },
  { id: "AML.TA0013", name: "Credential Access", techniques: [
    "AML.T0055 Unsecured Credentials", "AML.T0082 RAG Credential Harvesting", "AML.T0083 Credentials from AI Agent Configuration", "AML.T0090 OS Credential Dumping",
    "AML.T0098 AI Agent Tool Credential Harvesting", "AML.T0106 Exploitation for Credential Access" ] },
  { id: "AML.TA0008", name: "Discovery", techniques: [
    "AML.T0007 Discover AI Artifacts", "AML.T0013 Discover AI Model Ontology", "AML.T0014 Discover AI Model Family", "AML.T0062 Discover LLM Hallucinations",
    "AML.T0063 Discover AI Model Outputs", "AML.T0069 Discover LLM System Information (special character sets, system instruction keywords, system prompt)",
    "AML.T0075 Cloud Service Discovery", "AML.T0084 Discover AI Agent Configuration (embedded knowledge, tool definitions, activation triggers, call chains)", "AML.T0089 Process Discovery" ] },
  { id: "AML.TA0015", name: "Lateral Movement", techniques: [
    "AML.T0052 Phishing (from a compromised assistant)", "AML.T0091 Use Alternate Authentication Material (application access token)" ] },
  { id: "AML.TA0009", name: "Collection", techniques: [
    "AML.T0035 AI Artifact Collection", "AML.T0036 Data from Information Repositories", "AML.T0037 Data from Local System",
    "AML.T0085 Data from AI Services (RAG databases, AI agent tools)" ] },
  { id: "AML.TA0001", name: "AI Attack Staging", techniques: [
    "AML.T0005 Create Proxy AI Model", "AML.T0018 Manipulate AI Model", "AML.T0042 Verify Attack",
    "AML.T0043 Craft Adversarial Data (white-box, black-box, transfer, manual, backdoor trigger)", "AML.T0088 Generate Deepfakes", "AML.T0102 Generate Malicious Commands" ] },
  { id: "AML.TA0014", name: "Command and Control", techniques: [
    "AML.T0072 Reverse Shell", "AML.T0096 AI Service API", "AML.T0108 AI Agent" ] },
  { id: "AML.TA0010", name: "Exfiltration", techniques: [
    "AML.T0024 Exfiltration via AI Inference API (membership inference, model inversion, model extraction)", "AML.T0025 Exfiltration via Cyber Means",
    "AML.T0056 Extract LLM System Prompt", "AML.T0057 LLM Data Leakage", "AML.T0077 LLM Response Rendering (markdown images, links that carry data)",
    "AML.T0086 Exfiltration via AI Agent Tool Invocation" ] },
  { id: "AML.TA0011", name: "Impact", techniques: [
    "AML.T0015 Evade AI Model", "AML.T0029 Denial of AI Service", "AML.T0031 Erode AI Model Integrity",
    "AML.T0034 Cost Harvesting (excessive queries, resource-intensive queries, agentic resource consumption)", "AML.T0046 Spamming AI System with Chaff Data",
    "AML.T0048 External Harms (financial, reputational, societal, user, AI IP theft)", "AML.T0059 Erode Dataset Integrity",
    "AML.T0101 Data Destruction via AI Agent Tool Invocation", "AML.T0112 Machine Compromise (local AI agent, AI artifacts)" ] },
];

export interface Mitigation { id: string; name: string }

export const ATLAS_MITIGATIONS: Mitigation[] = [
  { id: "AML.M0000", name: "Limit Public Release of Information" }, { id: "AML.M0001", name: "Limit Model Artifact Release" },
  { id: "AML.M0002", name: "Passive AI Output Obfuscation" }, { id: "AML.M0003", name: "Model Hardening" },
  { id: "AML.M0004", name: "Restrict Number of AI Model Queries" }, { id: "AML.M0005", name: "Control Access to AI Models and Data at Rest" },
  { id: "AML.M0006", name: "Use Ensemble Methods" }, { id: "AML.M0007", name: "Sanitize Training Data" },
  { id: "AML.M0008", name: "Validate AI Model" }, { id: "AML.M0009", name: "Use Multi-Modal Sensors" },
  { id: "AML.M0010", name: "Input Restoration" }, { id: "AML.M0011", name: "Restrict Library Loading" },
  { id: "AML.M0012", name: "Encrypt Sensitive Information" }, { id: "AML.M0013", name: "Code Signing" },
  { id: "AML.M0014", name: "Verify AI Artifacts" }, { id: "AML.M0015", name: "Adversarial Input Detection" },
  { id: "AML.M0016", name: "Vulnerability Scanning" }, { id: "AML.M0017", name: "AI Model Distribution Methods" },
  { id: "AML.M0018", name: "User Training" }, { id: "AML.M0019", name: "Control Access to AI Models and Data in Production" },
  { id: "AML.M0020", name: "Generative AI Guardrails" }, { id: "AML.M0021", name: "Generative AI Guidelines" },
  { id: "AML.M0022", name: "Generative AI Model Alignment" }, { id: "AML.M0023", name: "AI Bill of Materials" },
  { id: "AML.M0024", name: "AI Telemetry Logging" }, { id: "AML.M0025", name: "Maintain AI Dataset Provenance" },
  { id: "AML.M0026", name: "Privileged AI Agent Permissions Configuration" }, { id: "AML.M0027", name: "Single-User AI Agent Permissions Configuration" },
  { id: "AML.M0028", name: "AI Agent Tools Permissions Configuration" }, { id: "AML.M0029", name: "Human In-the-Loop for AI Agent Actions" },
  { id: "AML.M0030", name: "Restrict AI Agent Tool Invocation on Untrusted Data" }, { id: "AML.M0031", name: "Memory Hardening" },
  { id: "AML.M0032", name: "Segmentation of AI Agent Components" }, { id: "AML.M0033", name: "Input and Output Validation for AI Agent Components" },
  { id: "AML.M0034", name: "Deepfake Detection" },
];

export interface StrideCategory { letter: string; name: string; violates: string; asks: string }

export const STRIDE: StrideCategory[] = [
  { letter: "S", name: "Spoofing", violates: "authentication", asks: "can someone pretend to be this user, service or device?" },
  { letter: "T", name: "Tampering", violates: "integrity", asks: "can data, code, config or a message be changed without detection?" },
  { letter: "R", name: "Repudiation", violates: "non-repudiation", asks: "can an action be denied later because nothing trustworthy recorded it?" },
  { letter: "I", name: "Information disclosure", violates: "confidentiality", asks: "can data be read by someone who should not?" },
  { letter: "D", name: "Denial of service", violates: "availability", asks: "can it be exhausted, crashed or locked?" },
  { letter: "E", name: "Elevation of privilege", violates: "authorisation", asks: "can a lower-privileged party do a higher-privileged thing?" },
];

/** Which STRIDE categories apply to each element type (the classic DFD mapping, plus AI elements). */
export const STRIDE_BY_ELEMENT: Record<string, string> = {
  actor: "SR",
  external: "SRD",
  service: "STRIDE",
  ai: "STRIDE",
  datastore: "TRID",
  flow: "TID",
};
