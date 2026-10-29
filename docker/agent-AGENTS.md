# BugXHunter sandbox — how this environment works

You are running inside a sandboxed container managed by BugXHunter. Read this before using the network.

## Network: direct internet

- You have **direct internet access**. `curl`, `wget`, `git`, `pip`, `npm`, `nmap`, `ping`,
  `dig`, and your `webfetch`/`websearch` tools all work normally. Outbound connections are logged.
- `runner` is the BugXHunter backend (it serves the model API); it is not a scan target.
- **Only reach targets the user has authorised.** You have unrestricted outbound, so the
  responsibility is yours: confirm authorisation before scanning, and never touch a host the user
  hasn't named.

## Security-testing tools

Installed for **authorised** testing only. Confirm the user is authorised to test a target
before scanning it, and never scan a host the user has not named.

Web tools (direct internet):
- `nuclei` (CVEs, misconfigs, exposed panels, takeovers; templates are pre-installed), `httpx`
  (probe, tech/CDN detect, headers), `katana` (crawler — parses JS to find endpoints/params in
  static & single-page sites; feed its output into nuclei/ffuf), `ffuf` (dir/param/LFI fuzzing;
  wordlists in `$SECLISTS_DIR`, i.e. `/opt/wordlists`), `testssl` (deep TLS/SSL — just run
  `testssl https://TARGET`), `curl`, `openssl`, and `subfinder`. For web vuln/CVE scanning use
  nuclei (not nikto — intentionally not installed; slow and useless against CDN/static targets).

Raw-socket tools (work directly): `nmap`, `ping`, `traceroute`, and `dig`/`host` incl. zone transfer.

Local tools (no network):
- `gitleaks` scans a repo and its git history for leaked secrets/keys/tokens. Run it on repos the
  user copies into the project and on built JS bundles, e.g. `gitleaks detect --source . --no-git`
  for a plain folder, or `gitleaks detect --source .` for a git repo. Save the report under the
  project folder.

Wordlists: `/opt/wordlists` (common.txt, common-api-endpoints-mazen160.txt,
raft-medium-directories.txt, subdomains-top1million-5000.txt, LFI-Jhaddix.txt, Generic-SQLi.txt,
XSS-Jhaddix.txt). Save findings under the project folder.

## Rust and Go

The full image (not `-slim`; check with `command -v cargo go`) has both toolchains, so a Rust or
Go repository can be built, tested and audited in place:
- **Rust** (stable, via rustup): `cargo build`, `cargo test`, `cargo clippy`, `cargo fmt`, and
  `cargo audit`, which checks `Cargo.lock` against the RustSec advisory database (it downloads
  the database on first run). `rustup target add` and `cargo install` work as the node user.
- **Go**: `go build`, `go test`, `go vet`, and `govulncheck ./...`, Go's vulnerability scanner,
  which reports only the vulnerabilities the code actually reaches. A `go.mod` that asks for a
  newer Go downloads that toolchain automatically.

For a dependency review of a Rust or Go repo, run `cargo audit` or `govulncheck` alongside
gitleaks and save the reports under the project folder. Downloaded crates and modules are not
kept across container restarts; the project folder is.

## Screenshots and other images

Not every model can view images (GLM-5.3 cannot; it receives the bytes as text). If a `read` of an
image comes back as unreadable or you are told the model has no image input, do not guess and do
not try to decode the file yourself: delegate to the **`vision`** subagent via the `task` tool with
the file path(s) and what to look for (e.g. "read /workspace/x/shot.png — what is the chat widget's
input placeholder and send-button label?"). It runs on an image-capable model and reports back
what is visible. Models with image input can read image files directly.

## Optional: LLM red-teaming tools (not installed — add them when a task needs them)

`promptfoo` and `garak` are deliberately NOT baked into the image: installed they are about
1.4 GB and 2 GB respectively, more than the rest of the image together. When the user wants to
red-team an LLM app, chatbot or model endpoint, install them under `/workspace/.tools` — that
path is a persistent volume, so a container restart keeps them (`/home/node` and `/usr/local` do
not persist). Tell the user it is a one-off download of a few minutes, and only install the one
the task needs.

- **promptfoo** (LLM evals + red-team plugins; ~1.4 GB, 2–3 min):
  `mkdir -p /workspace/.tools/promptfoo && cd /workspace/.tools/promptfoo && npm init -y >/dev/null && npm install promptfoo`
  Run it as `/workspace/.tools/promptfoo/node_modules/.bin/promptfoo` (or add that dir to PATH).
- **garak** (LLM probe scanner; ~2 GB, 3–5 min). Install CPU-only torch FIRST — a plain
  `pip install garak` pulls the CUDA build of torch instead (5 GB+, useless here: no GPU):
  `python3 -m venv /workspace/.tools/garak`
  `/workspace/.tools/garak/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu`
  `/workspace/.tools/garak/bin/pip install garak`
  Run it as `/workspace/.tools/garak/bin/garak` (`--list_probes`; `--target_type rest -G cfg.json`
  for an HTTP endpoint).

Both can use the runner's model proxy as an OpenAI-compatible endpoint for attacker/grader
models (only `/chat/completions` and `/models` are proxied): base URL `http://runner:8790/scx/v1`,
API key `$SCX_PROXY_TOKEN`, model ids as in the Playground (e.g. `GLM-5.3`). promptfoo: provider
`openai:chat:GLM-5.3` with `config.apiBaseUrl` and `config.apiKeyEnvar: SCX_PROXY_TOKEN`. garak:
`--target_type openai.OpenAICompatible` with `OPENAICOMPATIBLE_API_KEY=$SCX_PROXY_TOKEN` and the
`uri` option. Memory is capped at 4 GB: prefer API-backed detectors over garak's local
HuggingFace models.

## Running scans efficiently (important — scans are slow if done naively)

Scope beats speed. A blind full-template nuclei run fires thousands of requests, most irrelevant.

- **Scope nuclei templates** — this is the biggest win. Use `-tags cve,exposure` or
  `-severity critical,high,medium`, or `-t http/exposures/`. Only run the whole set when the user
  explicitly asks for an exhaustive scan. Fingerprint first with httpx and target templates to the
  detected stack.
- **Pre-filter the surface.** Crawl with katana / probe with httpx and feed only live, relevant
  URLs into nuclei/ffuf instead of blind-scanning.
- **Tune concurrency to the target, not blindly up.** `-c 50 -rl 300 -bulk-size 50 -timeout 5` on a
  tolerant host; but LOWER it on a CDN/WAF target — aggression there trips rate-limits and tarpits,
  which is slower and noisier, not faster.
- **Run long scans detached**, writing output to the project folder (`-o result.txt`), and poll the
  file — so an aborted turn or reload doesn't lose progress.

## CTF challenges and labs

In scope only when the user says the challenge is theirs, a lab, or an event they are registered
for. Keep the original files untouched and work on copies under the project folder. Keep a notes
file (`notes.md`: every attempt, exact input, exact output) and a write-up at the end: the
vulnerability, its OWASP or ATLAS id, the steps, the lesson and the real-world fix.

**First look, before thinking about the category:** read the challenge text and name twice and
note the flag format; for a file run `file`, `strings -n 8`, `exiftool`, `binwalk`, `xxd | head`
and `xxd | tail`, and `7z l` for anything archive-like; for a service connect once and read what
it prints; for a URL read the source, `robots.txt`, the JS bundles, the headers and the error
page. Then name the category, the two or three likely families, and the next three experiments,
cheapest first. When a candidate flag appears, print it on its own line: the UI highlights
anything matching the flag format.

**Installed (full image; `--build-arg CTFTOOLS=1` adds them to a slim one):** `file`, `strings`,
`objdump`/`readelf`, `binwalk`, `exiftool`, `exiv2`, `pngcheck`, `steghide`, `foremost`, `7z`,
`tshark` (read captures: `-r file.pcap -q -z conv,tcp`, `-Y http`, `--export-objects http,dir`),
`john` (with `/opt/wordlists` and the `*2john` converters), `sqlmap` (only after a manual probe
shows injection), `gdb`, `ltrace`, `strace`, and Python's `pwntools`, `pycryptodome` (Debian's
build imports as `Cryptodome`, not `Crypto`), `z3` and `yara`.

**On demand, under the persistent `/workspace/.tools`** (`/home/node` does not survive a restart):
- gef for gdb: `mkdir -p /workspace/.tools && curl -fsSL -o /workspace/.tools/gef.py https://gef.blah.cat/py`,
  then `echo "source /workspace/.tools/gef.py" >> ~/.gdbinit` (re-run the echo after a restart).
- RsaCtfTool: `git clone --depth 1 https://github.com/RsaCtfTool/RsaCtfTool /workspace/.tools/RsaCtfTool && python3 -m venv /workspace/.tools/rsa && /workspace/.tools/rsa/bin/pip install -r /workspace/.tools/RsaCtfTool/requirements.txt`.
- Volatility 3: `python3 -m venv /workspace/.tools/vol && /workspace/.tools/vol/bin/pip install volatility3`,
  then `/workspace/.tools/vol/bin/vol -f image.raw windows.pslist`.
- rockyou and other big wordlists (about 53 MB down, 133 MB on disk): `mkdir -p /workspace/.tools/wordlists && curl -fsSL https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Leaked-Databases/rockyou.txt.tar.gz | tar xz -C /workspace/.tools/wordlists`.
- radare2 (not packaged on this base image): `git clone --depth 1 https://github.com/radareorg/radare2 /workspace/.tools/radare2 && /workspace/.tools/radare2/sys/user.sh`
  installs under `$HOME` and takes a few minutes; re-run the install script after a restart, or stay with `gdb` + gef and `objdump`.
- Ghidra and hashcat are not provided: say so and work with `gdb`, `objdump` and `john`.

**By category, the first families to test:** web: injection (SQL, SSTI, command), access (IDOR,
JWT alg none and weak secrets), files (LFI wrappers, upload bypass), SSRF, deserialisation,
race conditions, type juggling. crypto: identify the scheme first; RSA small e, Wiener, common
modulus, Fermat; ECB cut-and-paste, CBC padding oracle, CTR nonce reuse; hash length extension;
XOR and classical ciphers by frequency. forensics: appended and embedded files, LSB stego,
audio spectrograms, metadata, capture streams and exported objects, memory images. reverse: the
first comparison on the input, XOR and table transforms, packed binaries, patch rather than
understand when possible, z3 for invertible checks. pwn: `checksec`, find the bug, the offset
with `cyclic`, a leak, then ret2win, ret2libc or ROP, format strings, tcache. AI and LLM: direct
and indirect prompt injection, system-prompt extraction, exfiltration through rendering or
tools, encoding to pass filters, memory poisoning; map each to its ATLAS id.

## Methodology: what a review or test must cover

Work from the published lists, cite their ids in every finding, and end a report with a coverage
line (the categories considered and found clean), so silence is never read as safety. The
Playground's presets carry the same catalogue (web/src/intel), so findings line up across the app.

**Order of a web or API test (OWASP WSTG 4.2):** WSTG-INFO information gathering (httpx,
katana, subfinder, search engines) → WSTG-CONF configuration and deployment (nuclei exposures,
HTTP methods, backups, admin interfaces, cloud storage) → WSTG-IDNT identity → WSTG-ATHN
authentication → WSTG-ATHZ authorization (IDOR, traversal, privilege escalation) → WSTG-SESS
session management → WSTG-INPV injection (SQL, command, template, XSS, SSRF, smuggling) →
WSTG-ERRH error handling → WSTG-CRYP cryptography (testssl) → WSTG-BUSL business logic →
WSTG-CLNT client-side → WSTG-APIT API testing (GraphQL, BOLA). Fingerprint first, then target
templates to the stack; capture evidence (request, response, screenshot) for each finding.

**OWASP Top 10:2025, each one considered for every target:** A01:2025 Broken Access Control ·
A02:2025 Security Misconfiguration · A03:2025 Software Supply Chain Failures · A04:2025
Cryptographic Failures · A05:2025 Injection · A06:2025 Insecure Design · A07:2025 Authentication
Failures · A08:2025 Software or Data Integrity Failures · A09:2025 Security Logging and Alerting
Failures · A10:2025 Mishandling of Exceptional Conditions.

**OWASP API Security Top 10:2023, for every API:** API1:2023 Broken Object Level Authorization ·
API2:2023 Broken Authentication · API3:2023 Broken Object Property Level Authorization ·
API4:2023 Unrestricted Resource Consumption · API5:2023 Broken Function Level Authorization ·
API6:2023 Unrestricted Access to Sensitive Business Flows · API7:2023 Server Side Request Forgery
· API8:2023 Security Misconfiguration · API9:2023 Improper Inventory Management · API10:2023
Unsafe Consumption of APIs.

**AI systems (anything that calls a model, runs an agent, retrieves for a model, or trains one).**
OWASP Top 10 for LLM Applications 2025: LLM01:2025 Prompt Injection · LLM02:2025 Sensitive
Information Disclosure · LLM03:2025 Supply Chain · LLM04:2025 Data and Model Poisoning ·
LLM05:2025 Improper Output Handling · LLM06:2025 Excessive Agency · LLM07:2025 System Prompt
Leakage · LLM08:2025 Vector and Embedding Weaknesses · LLM09:2025 Misinformation · LLM10:2025
Unbounded Consumption. OWASP Top 10 for Agentic Applications 2026: ASI01:2026 Agent Goal Hijack
· ASI02:2026 Tool Misuse and Exploitation · ASI03:2026 Identity and Privilege Abuse · ASI04:2026
Agentic Supply Chain Vulnerabilities · ASI05:2026 Unexpected Code Execution · ASI06:2026 Memory
and Context Poisoning · ASI07:2026 Insecure Inter-Agent Communication · ASI08:2026 Cascading
Failures · ASI09:2026 Human-Agent Trust Exploitation · ASI10:2026 Rogue Agents.
MITRE ATLAS tactics (cite techniques as AML.Txxxx and mitigations as AML.Mxxxx): AML.TA0002
Reconnaissance · AML.TA0003 Resource Development · AML.TA0004 Initial Access · AML.TA0000 AI
Model Access · AML.TA0005 Execution (AML.T0051 LLM Prompt Injection: direct .000, indirect .001,
triggered .002; AML.T0053 AI Agent Tool Invocation) · AML.TA0006 Persistence (AML.T0070 RAG
Poisoning, AML.T0080 AI Agent Context Poisoning) · AML.TA0012 Privilege Escalation (AML.T0054
LLM Jailbreak, AML.T0105 Escape to Host) · AML.TA0007 Defense Evasion · AML.TA0013 Credential
Access · AML.TA0008 Discovery (AML.T0069 Discover LLM System Information, AML.T0084 Discover AI
Agent Configuration) · AML.TA0015 Lateral Movement · AML.TA0009 Collection · AML.TA0001 AI
Attack Staging · AML.TA0014 Command and Control · AML.TA0010 Exfiltration (AML.T0056 Extract LLM
System Prompt, AML.T0057 LLM Data Leakage, AML.T0077 LLM Response Rendering, AML.T0086
Exfiltration via AI Agent Tool Invocation) · AML.TA0011 Impact (AML.T0029 Denial of AI Service,
AML.T0034 Cost Harvesting, AML.T0101 Data Destruction via AI Agent Tool Invocation).
Rules for AI targets: treat every input the model reads as attacker-controlled and every model
output as untrusted input to whatever consumes it; check what the model can trigger (tools,
shells, HTTP, files) and with whose credentials; check tenant isolation of retrieval; the
promptfoo and garak probes below map to AML.T0051, AML.T0054, AML.T0056 and AML.T0057, and the
fixes to AML.M0020 guardrails, AML.M0028 tool permissions, AML.M0029 human in the loop,
AML.M0030 no tool invocation on untrusted data, AML.M0032 segmentation and AML.M0033 input and
output validation.

**Verification (OWASP ASVS 5.0 chapters, name the one each fix is checked against):** V1 Encoding
and Sanitization · V2 Validation and Business Logic · V3 Web Frontend Security · V4 API and Web
Service · V5 File Handling · V6 Authentication · V7 Session Management · V8 Authorization · V9
Self-contained Tokens · V10 OAuth and OIDC · V11 Cryptography · V12 Secure Communication · V13
Configuration · V14 Data Protection · V15 Secure Coding and Architecture · V16 Security Logging
and Error Handling · V17 WebRTC.

**Severity:** rate by what an attacker gets. critical = unauthenticated or any user reaches other
users' or regulated data, runs code, or takes over accounts or infrastructure; high = the same with
one precondition, or sensitive data at scale; medium = limited data or users, chaining or an
unlikely precondition, or a missing defence-in-depth control; low = hygiene or no direct path to
harm. Business-critical data raises one step; a tested compensating control lowers one step.

**Report format:** for each finding: title, severity with its one-line reasoning, where (URL,
file:line, component), evidence, the ids (OWASP, CWE, ATLAS or ATT&CK), the fix and its ASVS
chapter. Save reports under the project folder.

**Tabletop exercises and CTFs.** A tabletop is a rehearsal of detection, decision and recovery:
build the scenario from real technique ids (ATT&CK, ATLAS, OWASP), release one inject at a
time, and map every gap found to the control that closes it. A CTF or lab is in scope only when
the user says it is theirs or they are registered for it; coach by method and category, map the
challenge to the OWASP or ATLAS category, and keep the write-up defensive (the lesson and the
real-world fix).

## Files

- Projects live under `/workspace`. Files the user attaches to a message are saved in the project's
  `attachments/` folder.
