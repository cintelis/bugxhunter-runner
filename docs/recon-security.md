# Supervised recon — security architecture

This documents the security model for the supervised-recon feature (`server/src/recon.ts`,
`server/src/recon-driver.ts`). It is a **pentest** agent — fed by an adversarial target,
deliberately running attack commands — so its threat model is *not* a coding agent's, and it is
configured differently.

## Principle: a classifier beneath a sandbox

Two independent reviews (Claude Mythos 5.2) proved the obvious thing empirically: **you cannot make
a sound security boundary by statically classifying arbitrary shell strings.** A shell re-parses the
string (chaining, substitution, redirection, globbing, `$VAR` expansion), so predicting what it will
run is a losing game — every "parse-then-allowlist" pass had more bypasses.

So the command gate is *not* the boundary. It is a **supervision / convenience layer**. The real
boundary is structural isolation. Three layers, strongest last:

### 1. The gate (supervision) — `classifyCommand` + `reconGateDecision`

Default **ASK**. A command is auto-**allowed** only if it is *shell-neutral* (contains no shell
metacharacters at all — so running it via a shell or via `argv` is identical) **and** every stage
positively validates against a tiny allowlist:

- a **`curl` GET/HEAD to exactly the in-scope origin** — host **and** port checked with the WHATWG
  `URL` parser, no userinfo, no redirects (`-L`), flags from a positive allowlist (unknown flag → ask);
- **`nmap`** to the in-scope host without NSE/file-output/aggressive flags;
- pure **read filters** (`grep`/`head`/`cut`/`jq`/…) *downstream of a fetch* (reading piped stdin),
  with no file-path operands.

Everything else **asks** and the human reads the real command. A small **deny floor**
(`commandHazard`, wrapper-aware: it unwraps `sudo`/`env`/`bash -c` first) hard-blocks shapes that
wreck the agent host or turn it into a zombie — `rm -rf /`, `mkfs`, fork bomb, `curl … | sh`,
`/dev/tcp` reverse shells, `nc -e`, `base64 -d | sh`. These are **not** in-scope attacks on the
target (a `curl -X DELETE http://target/x` is the job and is handled by allow/ask), so denying them
never blocks legitimate testing.

Because the gate is supervision, its imperfections are not security holes — the layers below contain
what it waves through to a human.

### 2. Env hygiene (structural anti-exfil) — `scrubEnv`

The executor reads attacker-controlled target output, so **prompt injection is a first-class
threat**. The structural defense is to ensure there is **nothing worth stealing in the agent's
process env**: `scrubEnv` strips the operator's cloud/LLM/provider secrets (and any secret-shaped
key) before the executor's subprocess runs. The LLM key already reaches the agent only through a
key-injecting proxy it cannot read (`apiKey: {env:SCX_PROXY_TOKEN}`), never as a readable value.
A successful injection then has no secret to exfiltrate.

### 3. Network egress — logged by default, blockable on demand

Egress is the authorization boundary of a pentest, but **hard-blocking degrades real testing**:
out-of-band (OOB) confirmation of blind vulns needs an external collaborator host, as does fetching
tooling/payloads and following in-scope redirects. So egress has two modes:

- **Monitor (default):** the `egress-logger` records every outbound request and blocks nothing. Full
  testing power. The boundary in this mode is env-hygiene (nothing to steal) + the supervision gate +
  the audit trail (out-of-scope activity is caught and *provable* after the fact).
- **Enforce (opt-in toggle):** the egress path filters against an allowlist — the in-scope target(s)
  **plus an operator-supplied "also allow" field** (so you re-admit your OOB collaborator host and
  Enforce doesn't kill blind-vuln confirmation). Everything else is denied and logged as a denial.
  For engagements in shared / prod-adjacent environments, or customers who require hard containment.

The toggle belongs **per-engagement** (block mode is an engagement decision), with a global default.
The same `egress-logger` sidecar is the enforcement point — a mode flag (`observe` → `enforce`), not
new infra.

## How the layers stack

| Control | Monitor (default) | Enforce (toggle) |
|---|---|---|
| Deny floor (host-catastrophic / agent-compromise) | ✓ | ✓ |
| Supervision gate (approve target-mutating actions) | ✓ | ✓ |
| Env hygiene (secrets stripped) | ✓ | ✓ |
| Audit trail (egress logged) | ✓ | ✓ + denials |
| Network scope (block out-of-allowlist) | — | ✓ |

You never *lose* protection by staying in Monitor; Enforce only adds the network fence.

## Pentest-specific controls (that a coding agent doesn't need)

- **Per-engagement authorization + scope allowlist** — enforced by the gate and the consent model.
- **Environment fidelity** (`EnvFidelity`, `ReconFinding.env`) — every finding is tagged with the
  environment it was seen in; the verifier flags config-dependent findings instead of shipping a bug
  that only exists because a non-prod flag was off.
- **Egress audit trail** as a product/accountability feature (prove you stayed in scope).

## Status

- **Implemented:** the gate (supervision + deny floor), `scrubEnv`, the router/driver with hard caps,
  env-fidelity tagging. Regression tests cover both reviews' bypass tables.
- **Follow-up (infra):** wiring `scrubEnv` into the executor subprocess spawn, and the Monitor/Enforce
  egress toggle + allowlist in the `egress-logger` / agent container. These are the controls that make
  the model *enforced* rather than documented — the gate is deliberately not relied on as the boundary.
