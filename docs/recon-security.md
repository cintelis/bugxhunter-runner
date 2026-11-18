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
The same `egress-logger` sidecar is the enforcement point — a mode flag, not new infra.

**Mechanism (implemented).** The sidecar shares the agent's network namespace. In `enforce` it installs
a deny-by-default `BXH_EGRESS` chain (`iptables` + `ip6tables`): loopback, established flows and DNS are
allowed, then each resolved allow destination (the in-scope target, `EGRESS_ALLOW` hosts/IPs/CIDRs, and
the model proxy), and the rest is REJECTed and rate-logged. Allow hostnames are re-resolved each cycle so
CDN/rotating IPs keep working. **Privilege separation:** only the sidecar holds `CAP_NET_ADMIN`, so the
agent — which shares the namespace but not the capability — cannot alter or remove the rules; and the
rules live in the kernel namespace, so they persist (fail-closed) even if the sidecar is restarted.
**Runtime toggle:** mode + allow come from `EGRESS_MODE`/`EGRESS_ALLOW`, overridable without a restart by
a JSON policy file (`/logs/egress-policy.json`, `{mode, allow}`) the runner writes per engagement; the
sidecar re-reads it each cycle and reconciles (installing or tearing down the chain). Denials surface in
the egress log as an `egress.denied` running count (from the REJECT rule's packet counter).

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
- **Env hygiene wired (local mode):** the OpenCode agent is spawned inside `withScrubbedEnv`
  (`server/src/opencode.ts`, `getServer`), so the agent and its shell inherit an env with the
  operator's secrets removed. The SDK snapshots `process.env` synchronously at spawn, so the scrub
  window is exactly that spawn and the runner keeps its own secrets. **Docker mode** runs the agent as
  a separate container, so there the env must be scrubbed at the compose/container layer — though the
  runner already reaches the LLM only through a key-injecting proxy, so the real provider key never
  enters the agent container.
- **Egress Monitor/Enforce (implemented, Docker mode):** `docker/egress-logger.mjs` + the pure,
  unit-tested `docker/egress-filter.mjs` (see `server/src/egress-filter.test.ts`). The sidecar installs
  the deny-by-default chain in `enforce` and tears it down in `monitor`, driven by env or the runtime
  policy file. The agent image ships `iptables`; the sidecar gains `CAP_NET_ADMIN` in compose.
- **Follow-up (infra):**
  - **Per-destination denial logging:** denials are currently a running count (packet counter) plus
    `iptables` LOG lines in the kernel log; wiring NFLOG → the JSONL would name each blocked destination.
  - **Runner-side wiring:** a UI control that writes `/logs/egress-policy.json` (mode + the engagement's
    scope and "also allow" host) so operators flip Enforce per engagement without editing `.env`.
  - **IPv6:** enforced when the namespace has `ip6tables`; if it doesn't, the sidecar logs
    `egress.enforce.v6_unavailable` and proceeds on IPv4 (a theoretical v6 bypass only if the target has
    a reachable AAAA — uncommon in the default bridge).
  - The compose-layer env scrub for Docker mode (secrets out of the agent container's environment).
