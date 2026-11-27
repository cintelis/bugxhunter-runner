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
  each with its own positive flag allowlist (unknown flag → ask, so `rg --pre`, `sort -o`,
  `sort --compress-program`, `grep -r`/`-f` and `jq --rawfile` all ask) and no more operands than
  it needs to read stdin, so none can name a file.

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
a deny-by-default `BXH_EGRESS` chain (`iptables` + `ip6tables`): loopback and DNS *to the pinned
resolvers* are allowed, then each resolved allow destination (`EGRESS_ALLOW` hosts/IPs/CIDRs and the
model proxy), and the rest is REJECTed and rate-logged. Allow hostnames are re-resolved each cycle so
CDN/rotating IPs keep working. Some deliberate choices from the Mythos review:

- **DNS is pinned, not blanket.** Only the resolvers in `/etc/resolv.conf` (plus `EGRESS_DNS`) are
  allowed on port 53 — an unrestricted `--dport 53` accept would let `curl http://evil:53` walk straight
  out. Docker's embedded `127.0.0.11` is covered by the loopback accept. **Caveat:** on a compose network
  resolv.conf lists *only* `127.0.0.11`, which forwards upstream *from inside the agent's namespace*, so
  those forwarded queries traverse the chain — set `EGRESS_DNS` to the real upstream resolver (or give the
  agent an explicit `dns:`) or external name resolution fails under enforce. This Docker-runtime behaviour
  needs a compose integration test to confirm; **treat enforce as experimental** until then.
- **No `ESTABLISHED,RELATED` accept.** In an OUTPUT, destination-based chain every legitimate flow
  already matches its `-d` rule; a broad established accept would instead keep monitor-era tunnels alive
  across a flip and survive an allowlist shrink. Omitting it means removing a host cuts its live flows.
- **Atomic apply.** The chain is rebuilt with a single `iptables-restore --noflush` transaction, so it
  is never momentarily empty (no fall-through-to-ACCEPT window during a rebuild).
- **Fail loud.** Any `iptables` failure throws; the sidecar emits `egress.enforce.failed` and does *not*
  report enforcement, rather than silently leaving the agent open. A torn/empty/unreadable policy file, or
  one with an unknown mode or extra keys, is reported (`egress.policy_invalid`) and ignored while the
  last-good policy keeps running — a bad read never tears the chain down. The jump is re-verified every
  cycle (re-contains a namespace that lost the chain), and IPv6 failures are logged and retried.

**Privilege separation:** only the sidecar holds `CAP_NET_ADMIN`, so the agent — which shares the
namespace but not the capability — cannot alter or remove the *rules*. **Runtime toggle:** mode + allow
come from `EGRESS_MODE`/`EGRESS_ALLOW`, overridable without a restart by a JSON policy file
(`/logs/egress-policy.json`, `{mode, allow}`) the runner writes per engagement; env `EGRESS_MODE=enforce`
is a **floor** the file cannot lower, and a malformed/unknown-mode file is ignored (`egress.policy_invalid`)
while the last-good enforcement holds — a torn read never tears the chain down. Denials surface as an
`egress.denied` running count (the REJECT rule's packet counter); the kernel `LOG` lines only appear if
`nf_log_all_netns=1`, so don't rely on them.

**Threat model — what enforce does *not* do.** Enforce is **defense-in-depth egress control, not a hard
containment boundary against an agent actively trying to escape.** Two structural gaps remain (tracked
as follow-ups), which is why structural isolation + nothing-to-steal stays the real boundary:

- **The agent holds `CAP_NET_RAW`** (for `nmap`/`ping`). Raw/`AF_PACKET` sockets transmit *below*
  netfilter, so a determined agent can craft packets that bypass the filter, and could sniff/spoof the
  sidecar's DNS on loopback to poison the allowlist. Closing this means dropping `NET_RAW` in enforce
  (losing raw-socket scans) or enforcing outside the agent's namespace.
- **Namespace lifecycle.** The rules live in the agent's shared network namespace. With
  `network_mode: service:agent` the sidecar stays attached to the *old, orphaned* namespace if the agent
  restarts (including by OOM-ing itself); the restarted agent gets a fresh namespace with **no chain and
  no sniffer** and runs unfiltered until the stack is recreated. There is also a short install window at
  first start. True containment needs the enforcement point *outside* the agent's namespace — a gateway
  container the agent routes through, or the host `DOCKER-USER` chain. (The per-cycle jump re-verify only
  helps while the sidecar is in the *same* namespace as the agent.)

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
- **Following a finding up has no permission of its own either.** From the second round on, the
  main loop's prompt lists the verified findings and asks what they unlock before it asks for a
  fresh hypothesis. It is a prompt, nothing more: the step it leads to goes through the same gate
  and the same scope, and a path shown this way is ruled on by `recon-verify` and held to the
  same code rules as a path from the chain pass.
- **A captured session is a credential, and is handled as one.**
  - *Getting it in.* `POST /api/capture/session` is the one API route that needs no sign-in. It
    needs a pairing code instead: 24 random bytes, issued to a signed-in person for one target,
    kept only as a hash, good for ten minutes and for one accepted post. A capture for any other
    host or port is refused. The extension holds no standing access: it requests a site's
    permission when the person presses a button on that site.
  - *What is kept.* Only cookies the browser would send to the target's host, with names and
    values that cannot start a new line in a cookie jar or a header file. Sealed with the vault
    key; nothing about the target is readable in the file.
  - *What the run gets.* Two files in the project folder, in a folder of their own per run,
    removed when the run ends (or if it fails to start). The values are never in a prompt. The
    gate allows `curl -b <that jar>` and `curl -H @<that header file>` only under the rules a
    read already has (GET or HEAD, exactly the in-scope origin, no redirects), so the session
    cannot be sent to another host without a person approving it. A request that would print it
    (`-v`) asks.
  - *What this does not stop.* The agent's container can read the files during the run, so a
    model that ignores its instructions could put the values in its transcript, and from there
    they go to the model provider. A read sent as a logged-in user can also have effects a
    logged-out one cannot (a `GET /logout`, a badly designed `GET` that changes state). Both
    are why the dialog says to use a test account.
- **Memory is data from an earlier model run.** What a finished run verified is sealed with the
  vault key on the runner's volume and, on the next run against the same host and port, listed in
  the opening prompt. That text was written by a model about a target, so it is as trustworthy as
  a transcript and no more: it is clipped to one line per item, introduced as records and not
  instructions, and nothing in it becomes a finding of the new run unless the executor reproduces
  it and `recon-verify` rules on the new evidence. It grants nothing: the gate and the scope of
  the new run decide every command. Memory is keyed by host and port, so it is not offered to a
  run on another target.
- **The chain pass has no permission of its own.** After the main loop it proposes attack paths from
  the verified findings and tries each one with the same runner, the same gate and the same scope: a
  state-changing step still waits for a person, and an out-of-scope host still asks. What the model
  writes about a path stays data. The code, not the model, decides that a link must name a finding
  of the run, that a path with an unevidenced step is partial, that it is config-dependent if a
  finding it uses is, and that it is never rated below its worst finding. Its turns are capped
  (paths, rounds per path) and it cannot spend past the run's token budget.

## Status

- **Implemented:** the gate (supervision + deny floor), `scrubEnv`, the router/driver with hard caps,
  env-fidelity tagging. Regression tests cover both reviews' bypass tables.
- **Wired in (`server/src/recon-run.ts`):** `POST /api/agent/recon` starts a run on a session; the runner
  subscribes to OpenCode's events and answers each `permission.asked` of that session and its subagents
  from the gate (allow → `once`, deny → `reject`, ask → left pending for the person). The command it
  judges is the request's `metadata.command`, else the `command` input of the tool call the request
  names; never the glob in `patterns`. A reply of `always` is downgraded to `once` while a run is going,
  so OpenCode keeps asking and the gate sees every command.
- **Agent permissions, not `tools`:** the recon agents are configured with permission rules. OpenCode
  turns `tools: { bash: true }` into a trailing `bash: allow` rule that outranks the global `bash: ask`,
  which would run the executor's shell with no approval at all. The executor is `bash: ask`; every recon
  agent is `webfetch: deny` and `websearch: deny`. A test pins this, and that `docker/opencode.json`
  carries the same agents.
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
- **Follow-up (infra) — from the Mythos review of PR #43:**
  - **Enforce outside the namespace** (gateway container / host `DOCKER-USER`), and/or drop `NET_RAW`
    in enforce — the real fix for the two threat-model gaps above (#4, #6).
  - **IPv6 hardening** (#8): when `ip6tables` is missing the sidecar logs `egress.enforce.v6_unavailable`
    and proceeds on IPv4 — if the namespace has a v6 route this is a real bypass, so enforce should refuse
    or disable v6 (`sysctl`). When v6 *is* enforced, add explicit NDP (ICMPv6 133–136) accepts.
  - **Don't trust DNS answers into private space** (#9): drop resolved IPs in link-local / loopback /
    RFC1918 / `169.254.169.254` unless an explicit literal covers them (blocks target-DNS SSRF to
    metadata/host).
  - **Resolution robustness** (#11): cache last-known-good IPs across a transient `SERVFAIL` so a DNS
    blip doesn't cut the target/proxy for a cycle; honour `/etc/hosts`.
  - **Teardown from kernel state** (#12) and **stricter `parseAllow`** via `net.isIP` (#13).
  - **Per-destination denial logging** via NFLOG → the JSONL (today: a running count).
  - **Runner-side wiring:** a UI control that writes `/logs/egress-policy.json` (mode + the engagement's
    scope and "also allow" host) so operators flip Enforce per engagement without editing `.env`.
  - The compose-layer env scrub for Docker mode (secrets out of the agent container's environment).
