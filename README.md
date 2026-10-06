# Open Runner

A web UI for the [OpenCode](https://opencode.ai) coding agent, running on open-weight models
(GLM-5.3 by default) through [SCX.ai](https://platform.scx.ai). Started from the `sovgov-poc`
chatbot designer.

- **Runner** — point it at a project folder and drive OpenCode's `build` (edits + shell) or
  `plan` (read-only) agent. Every file edit and shell command waits for your approval.
  Markdown replies, collapsible tool calls and reasoning, per-turn token counts, and a
  **Changes** view of what the agent edited (git repos only — OpenCode tracks changes via git).
- **Playground** — chat with any SCX model directly (no agent), with tool-calling, JSON mode,
  an embeddings-backed knowledge base and browser voice.

## Requirements

- Node 22+
- OpenCode installed and on `PATH`: `npm i -g opencode-ai`
- The SCX provider set up in `~/.config/opencode/opencode.jsonc` and its key stored with
  `opencode auth login` (choose **Other**, provider id `scx`). Open Runner reads the same key, so
  the CLI and the web UI always agree. Alternatively set `SCX_API=...` in a `.env` here.

## Run

```bash
npm install
npm run dev          # backend :8790 + web :5190
```

Open **http://localhost:5190**.

The backend starts its own OpenCode server on `127.0.0.1:8791` (it stops a stale one left on
that port by a previous run). Everything listens on localhost only — there is no login, so
don't expose these ports.

Set `OPEN_RUNNER_PASSWORD` (or let `docker/setup.ps1` write it to `.env`) to require a login
locally too.

## Docker (sandboxed agent + login)

```powershell
powershell -File docker/setup.ps1     # once: writes .env — login password, secrets, SCX key
docker compose up -d --build
```

Open **http://localhost:8790** and sign in with `OPEN_RUNNER_PASSWORD` from `.env`.

Two containers:

| Container | Holds | Network |
|---|---|---|
| `runner` | Web UI, login, SCX key, `/scx/v1` key proxy | shared bridge, published on 127.0.0.1 |
| `agent` | OpenCode, the agent's shell + scan tools, `/workspace` volume | shared bridge — **direct internet** |

- The agent's model calls go to `runner`'s proxy with a proxy token; the proxy swaps in the real
  key and only allows `/chat/completions` and `/models`. **The SCX key never enters the agent
  container** — this holds even though the agent has direct internet.
- Projects live in the `workspace` Docker volume (`/workspace`, a git repo so Changes work). No
  host folders are mounted. Copy a repo in as a snapshot, and results back out:

  ```powershell
  powershell -File docker/copy-in.ps1 C:\code\my-repo          # -> /workspace/my-repo (skips node_modules, .env, …)
  powershell -File docker/copy-out.ps1 my-repo C:\temp\my-repo-out
  ```

  (Plain `docker compose cp` also copies in, but leaves files owned by root, so the agent can't edit them.)
- **The agent has direct, ungated internet** so scan tools run at full speed (no per-site approval,
  and `nmap`/`ping`/raw DNS work via `NET_RAW`). There is no network approval gate — **only point
  the agent at targets you are authorised to test, and run this on a trusted machine/VM.**
- Both containers run as non-root with `no-new-privileges`; the agent drops all capabilities except
  `NET_RAW` and is limited to 2 CPUs, 4 GB RAM, 512 processes. Shell commands and file edits are
  still approved in the UI — that, plus the container/VM boundary and the isolated SCX key, is what
  contains the agent. The network is not gated.
- Port 8790 is published on localhost only. Put TLS (a reverse proxy) in front and set
  `COOKIE_SECURE=1` before exposing it to anyone else.

## Security-testing tools (authorised use only)

The agent image ships a standard pentest toolchain for **authorised** testing (your own sites,
labs, CTFs). Build with `--build-arg SECTOOLS=0` to leave them out.

- **Vuln / web:** `nuclei` (templates baked in offline), `httpx`, `katana` (SPA/JS crawler),
  `ffuf` (+ SecLists wordlists in `/opt/wordlists`), `testssl`, `curl`, `openssl`, `subfinder`
  (passive).
- **Secrets (local, no network):** `gitleaks` — scan copied-in repos and JS bundles for leaked keys.
- **Raw-socket:** `nmap`, `ping`, `traceroute`, `dig`/`host` (incl. zone transfer).

All tools run directly against targets — no proxy, no per-site approval. The agent's `AGENTS.md`
tells it to confirm authorisation before scanning and to scan only hosts you name.

**Making scans fast** (they're slow if done naively):
- **Scope nuclei templates** — the biggest lever. `-tags cve,exposure` or `-severity
  critical,high,medium` instead of all ~14k templates. Fingerprint with httpx first and target the
  detected stack.
- **Pre-filter** with katana/httpx and feed only live URLs into nuclei/ffuf.
- **Tune to the target:** `-c 50 -rl 300 -bulk-size 50 -timeout 5` on a tolerant host; *lower* on a
  CDN/WAF target, where aggression trips rate-limits and is slower.
- **Run long scans detached**, writing to `/workspace` (`-o result.txt`), and poll the file so an
  aborted turn doesn't lose progress.

To fence the agent to a specific lab/target range, add firewall rules on the Docker host or the VM
you run this in — Docker's bridge NAT doesn't restrict outbound on its own.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `OPEN_RUNNER_MODEL` | `scx/GLM-5.3` | Default model for both agents |
| `OPEN_RUNNER_DIR` | this folder | Default project folder |
| `OPEN_RUNNER_AGENT_PORT` | `8791` | Port for the OpenCode server |
| `PORT` | `8790` | Backend port |
| `SCX_API` | key from `opencode auth login` | SCX key for the Playground (and the agent proxy in Docker) |
| `OPEN_RUNNER_PASSWORD` | unset (no login) | Enables the login screen |
| `OPEN_RUNNER_SECRET` | random per start | Signs session cookies; set it to keep sessions across restarts |
| `OPENCODE_URL` | unset (spawn locally) | Use a remote OpenCode server (Docker sets `http://agent:4096`) |
| `OPEN_RUNNER_WORKSPACE` | `/workspace` | Remote mode: projects must live under this folder |
| `SCX_PROXY_TOKEN` | unset | Enables the `/scx/v1` key proxy for the sandboxed agent |

## Layout

| Path | Role |
|---|---|
| `server/src/opencode.ts` | Starts/stops the OpenCode server, one SDK client per project folder, event mapping |
| `server/src/index.ts` | Express: `/api/agent/*` (OpenCode) and `/api/chat`, `/api/models`, `/api/kb` (SCX) |
| `server/src/scx.ts`, `rag.ts` | SCX client and in-memory knowledge base (Playground) |
| `web/src/AgentPanel.tsx` | Runner transcript, approvals, model picker, Changes view |
| `web/src/Sidebar.tsx` | Project folder picker (Runner) and model/prompt settings (Playground) |
| `web/src/styles.css`, `brand.tsx` | Theme tokens and logo |
