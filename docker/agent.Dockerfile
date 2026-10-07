# BugXHunter — sandboxed agent container.
# Runs `opencode serve` plus whatever the agent's shell needs. It holds no SCX
# key: model calls go through the key-injecting proxy in the runner container.
# It has direct internet (see docker-compose.yml); outbound is logged by the
# egress-logger sidecar, not gated.
FROM node:25-bookworm-slim

# Tools the agent commonly reaches for. Add your own (nmap, semgrep, …) here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl ripgrep jq less procps python3 python3-pip python3-venv tcpdump \
 && rm -rf /var/lib/apt/lists/*

# Passive egress logger (runs in a sidecar sharing the agent's network namespace).
COPY docker/egress-logger.mjs /usr/local/lib/egress-logger.mjs

ARG OPENCODE_VERSION=1.18.34
RUN npm install -g opencode-ai@${OPENCODE_VERSION} && npm cache clean --force

# ── Security-testing toolchain (opt-in: --build-arg SECTOOLS=0 to skip) ───────
# Standard open-source pentest tools for AUTHORISED testing only. Baked into the
# image so a fresh container is ready to scan without downloading anything.
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
        "Discovery/Web-Content/api-endpoints.txt" \
        "Discovery/Web-Content/raft-medium-directories.txt" \
        "Discovery/DNS/subdomains-top1million-5000.txt" \
        "Fuzzing/LFI/LFI-Jhaddix.txt" \
        "Fuzzing/SQLi/Generic-SQLi.txt" \
        "Fuzzing/XSS/XSS-Jhaddix.txt"; do \
        curl -fsSL "https://raw.githubusercontent.com/danielmiessler/SecLists/${SECLISTS_REF}/${W}" -o "/opt/wordlists/$(basename $W)"; \
      done; \
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
