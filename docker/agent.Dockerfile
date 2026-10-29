# BugXHunter — sandboxed agent container.
# Runs `opencode serve` plus whatever the agent's shell needs. It holds no SCX
# key: model calls go through the key-injecting proxy in the runner container.
# It has direct internet (see docker-compose.yml); outbound is logged by the
# egress-logger sidecar, not gated.
FROM node:22-bookworm-slim

# Tools the agent commonly reaches for. Add your own (nmap, semgrep, …) here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl ripgrep jq less procps python3 python3-pip python3-venv tcpdump \
 && rm -rf /var/lib/apt/lists/*

# Passive egress logger (runs in a sidecar sharing the agent's network namespace).
COPY docker/egress-logger.mjs /usr/local/lib/egress-logger.mjs

ARG OPENCODE_VERSION=1.18.34
# opencode-ai's postinstall hard-links the CPU-matched binary into bin/ and
# leaves the x64 "baseline" (no-AVX2) package behind as a second 178 MB copy.
# Every x86 CPU since 2013 has AVX2, so that copy is dropped (no-op on arm64).
RUN npm install -g opencode-ai@${OPENCODE_VERSION} && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/opencode-ai/node_modules/opencode-*-baseline

# ── Security-testing toolchain (--build-arg SECTOOLS=0 builds the `-slim` flavour) ──
# Standard open-source pentest tools for AUTHORISED testing only. Baked into the
# image so a fresh container is ready to scan without downloading anything. The
# slim flavour (ghcr.io/…/bugxhunter-agent:<tag>-slim) skips them: half the
# download, for code review of repositories only.
# Raw-socket tools (nmap, ping, traceroute) rely on the NET_RAW capability
# granted in docker-compose.yml.
ARG SECTOOLS=1
# Pinned releases: the build is reproducible and never depends on the GitHub
# API (whose rate limit used to turn into an obscure unzip failure). Bump here.
ARG NUCLEI_VERSION=3.11.1
ARG SUBFINDER_VERSION=2.16.0
ARG HTTPX_VERSION=1.12.0
ARG KATANA_VERSION=1.8.0
ARG FFUF_VERSION=2.3.0
ARG GITLEAKS_VERSION=8.30.1
ARG SECLISTS_REF=master
RUN if [ "$SECTOOLS" = "1" ]; then set -eux; \
      apt-get update && apt-get install -y --no-install-recommends \
        nmap netcat-openbsd dnsutils bind9-host iputils-ping traceroute whois \
        openssl unzip wget \
        bsdextrautils xxd \
      && rm -rf /var/lib/apt/lists/*; \
      # testssl.sh (deep TLS/SSL analysis)
      git clone --depth 1 https://github.com/drwetter/testssl.sh.git /opt/testssl \
      && ln -s /opt/testssl/testssl.sh /usr/local/bin/testssl; \
      # ProjectDiscovery: nuclei (vuln scan), subfinder (subdomains), httpx (probe),
      # katana (SPA/JS crawler — finds endpoints in static/single-page sites)
      ARCH=$(dpkg --print-architecture); \
      for TOOL in "nuclei $NUCLEI_VERSION" "subfinder $SUBFINDER_VERSION" "httpx $HTTPX_VERSION" "katana $KATANA_VERSION"; do \
        set -- $TOOL; NAME=$1; VER=$2; \
        curl -fsSL "https://github.com/projectdiscovery/${NAME}/releases/download/v${VER}/${NAME}_${VER}_linux_${ARCH}.zip" -o /tmp/${NAME}.zip; \
        unzip -o /tmp/${NAME}.zip -d /usr/local/bin/ ${NAME} && rm /tmp/${NAME}.zip; \
        chmod +x /usr/local/bin/${NAME}; \
      done; \
      # ffuf (fuzzer)
      curl -fsSL "https://github.com/ffuf/ffuf/releases/download/v${FFUF_VERSION}/ffuf_${FFUF_VERSION}_linux_${ARCH}.tar.gz" -o /tmp/ffuf.tar.gz; \
      tar xzf /tmp/ffuf.tar.gz -C /usr/local/bin/ ffuf && chmod +x /usr/local/bin/ffuf && rm /tmp/ffuf.tar.gz; \
      # gitleaks (secret scanning — runs locally, no network). Its release assets
      # use x64/arm64 arch names, not Debian's amd64/arm64.
      case "$ARCH" in amd64) GLARCH=x64;; arm64) GLARCH=arm64;; *) GLARCH=$ARCH;; esac; \
      curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${GLARCH}.tar.gz" -o /tmp/gitleaks.tar.gz; \
      tar xzf /tmp/gitleaks.tar.gz -C /usr/local/bin/ gitleaks && chmod +x /usr/local/bin/gitleaks && rm /tmp/gitleaks.tar.gz; \
      # SecLists wordlists (subset used by the scans)
      mkdir -p /opt/wordlists; \
      for W in \
        "Discovery/Web-Content/common.txt" \
        "Discovery/Web-Content/common-api-endpoints-mazen160.txt" \
        "Discovery/Web-Content/raft-medium-directories.txt" \
        "Discovery/DNS/subdomains-top1million-5000.txt" \
        "Fuzzing/LFI/LFI-Jhaddix.txt" \
        "Fuzzing/Databases/SQLi/Generic-SQLi.txt" \
        "Fuzzing/XSS/robot-friendly/XSS-Jhaddix.txt"; do \
        curl -fsSL "https://raw.githubusercontent.com/danielmiessler/SecLists/${SECLISTS_REF}/${W}" -o "/opt/wordlists/$(basename $W)"; \
      done; \
    fi

# ── CTF and forensics tools ──
# For labs and capture-the-flag work on the user's own challenges: file triage,
# steganography, captures, password cracking, debugging and exploit scripting.
# Follows SECTOOLS unless set: --build-arg CTFTOOLS=0 leaves them out of the
# full image, CTFTOOLS=1 adds them to a slim one. radare2, volatility3, gef,
# RsaCtfTool and the big wordlists are installed on demand (docker/agent-AGENTS.md).
ARG CTFTOOLS=
RUN if [ "${CTFTOOLS:-$SECTOOLS}" = "1" ]; then set -eux; \
      apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        file binutils binwalk libimage-exiftool-perl exiv2 pngcheck steghide foremost p7zip-full unzip \
        tshark john sqlmap gdb ltrace strace \
        python3-pwntools python3-pycryptodome python3-z3 python3-yara \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# ── Language toolchains: Rust and Go ──
# So the agent can build, test and audit Rust and Go repositories. Each follows
# SECTOOLS unless set: in the full image, not in `-slim`. --build-arg RUST=1 /
# GO=1 adds one to a slim build; RUST=0 / GO=0 leaves it out of a full one.
# gcc and libc6-dev are cargo's linker and Go's cgo; pkg-config and libssl-dev
# cover the common openssl-sys crate. Both are owned by node, so the agent can
# fetch crates and modules, add targets and install tools at run time.
ARG RUST=
ARG GO=
ARG RUST_VERSION=1.99.1
ARG CARGO_AUDIT_VERSION=0.22.2
ARG GO_VERSION=1.27.3
ARG GO_SHA256_AMD64=65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40
ARG GO_SHA256_ARM64=a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49
ARG GOVULNCHECK_VERSION=1.9.0
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo GOPATH=/home/node/go \
    PATH=/usr/local/cargo/bin:/usr/local/go/bin:/home/node/go/bin:$PATH
RUN if [ "${RUST:-$SECTOOLS}" = "1" ] || [ "${GO:-$SECTOOLS}" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev pkg-config libssl-dev \
      && rm -rf /var/lib/apt/lists/*; \
    fi
# Go: the official release archive, checked against its published SHA-256,
# plus govulncheck (Go's own vulnerability scanner).
RUN if [ "${GO:-$SECTOOLS}" = "1" ]; then set -eux; \
      ARCH=$(dpkg --print-architecture); \
      case "$ARCH" in amd64) SUM=$GO_SHA256_AMD64;; arm64) SUM=$GO_SHA256_ARM64;; esac; \
      curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" -o /tmp/go.tgz; \
      echo "$SUM  /tmp/go.tgz" | sha256sum -c -; \
      tar xzf /tmp/go.tgz -C /usr/local && rm -rf /tmp/go.tgz /usr/local/go/test /usr/local/go/api; \
      GOBIN=/usr/local/go/bin GOCACHE=/tmp/gocache GOPATH=/tmp/gopath \
        go install "golang.org/x/vuln/cmd/govulncheck@v${GOVULNCHECK_VERSION}"; \
      rm -rf /tmp/gocache /tmp/gopath; \
      mkdir -p "$GOPATH" && chown -R node:node "$GOPATH"; \
      go version && govulncheck -version; \
    fi
# Rust: rustup with the minimal profile, plus clippy, rustfmt and cargo-audit
# (checks Cargo.lock against the RustSec advisory database).
RUN if [ "${RUST:-$SECTOOLS}" = "1" ]; then set -eux; \
      curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal \
        --default-toolchain "$RUST_VERSION" --component clippy,rustfmt; \
      # cargo-audit's glibc builds need a newer glibc than Debian 12 has, so amd64
      # takes the static musl build and arm64 (no musl build) compiles it.
      if [ "$(dpkg --print-architecture)" = amd64 ]; then \
        T=x86_64-unknown-linux-musl; \
        curl -fsSL "https://github.com/rustsec/rustsec/releases/download/cargo-audit%2Fv${CARGO_AUDIT_VERSION}/cargo-audit-${T}-v${CARGO_AUDIT_VERSION}.tgz" \
          | tar xz -C "$CARGO_HOME/bin" --strip-components=1 "cargo-audit-${T}-v${CARGO_AUDIT_VERSION}/cargo-audit"; \
      else \
        cargo install --locked --version "$CARGO_AUDIT_VERSION" cargo-audit; \
      fi; \
      rm -rf "$RUSTUP_HOME/toolchains/"*/share/doc "$CARGO_HOME/registry" "$CARGO_HOME/git"; \
      chown -R node:node "$RUSTUP_HOME" "$CARGO_HOME"; \
      rustc --version && cargo --version && cargo clippy --version && cargo audit --version; \
    fi

COPY docker/agent-entrypoint.sh /usr/local/bin/agent-entrypoint
RUN chmod 755 /usr/local/bin/agent-entrypoint \
 && mkdir -p /workspace /logs /home/node/.local/share/opencode \
 && chown -R node:node /workspace /logs /home/node

USER node
COPY --chown=node:node docker/opencode.json /home/node/.config/opencode/opencode.json
# Global instructions OpenCode loads into every session: how the sandbox network works.
COPY --chown=node:node docker/agent-AGENTS.md /home/node/.config/opencode/AGENTS.md
RUN git config --global user.name "Open Runner agent" \
 && git config --global user.email "agent@open-runner.local" \
 && git config --global init.defaultBranch main

# Warm OpenCode's caches at build time so the first session starts fast.
RUN SCX_PROXY_TOKEN=build timeout 25 opencode serve --hostname 127.0.0.1 --port 4096 >/tmp/warm.log 2>&1; \
    tail -n 5 /tmp/warm.log; rm -f /tmp/warm.log

# Bake in nuclei's templates so scans don't start with a download.
# Harmless no-op when SECTOOLS=0.
RUN if [ "$SECTOOLS" = "1" ] && command -v nuclei >/dev/null; then \
      nuclei -update-templates 2>/dev/null || true; \
    fi
ENV SECLISTS_DIR=/opt/wordlists

WORKDIR /workspace
EXPOSE 4096
ENTRYPOINT ["agent-entrypoint"]
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
