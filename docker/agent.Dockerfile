# Open Runner — sandboxed agent container.
# Runs `opencode serve` plus whatever the agent's shell needs. It holds no SCX
# key and, in docker-compose.yml, sits on an internal network with no internet:
# model calls go through the key-injecting proxy in the runner container.
FROM node:22-bookworm-slim

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
# Standard open-source pentest tools for AUTHORISED testing only. Built here so
# the offline runtime container needs no downloads. HTTP-based tools (nuclei,
# httpx, ffuf, nikto, testssl, curl) work through the approval-gated proxy; raw
# tools (nmap, ping, traceroute, dig/zone-transfer) need the direct-egress mode
# (docker-compose.pentest.yml) — the HTTP proxy cannot carry raw sockets.
ARG SECTOOLS=1
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
      for TOOL in nuclei subfinder httpx katana; do \
        VER=$(curl -s https://api.github.com/repos/projectdiscovery/${TOOL}/releases/latest | grep tag_name | cut -d'"' -f4 | sed 's/v//'); \
        curl -sL "https://github.com/projectdiscovery/${TOOL}/releases/download/v${VER}/${TOOL}_${VER}_linux_${ARCH}.zip" -o /tmp/${TOOL}.zip; \
        unzip -o /tmp/${TOOL}.zip -d /usr/local/bin/ && rm /tmp/${TOOL}.zip; \
      done; \
      chmod +x /usr/local/bin/nuclei /usr/local/bin/subfinder /usr/local/bin/httpx /usr/local/bin/katana; \
      # ffuf (fuzzer)
      ARCH=$(dpkg --print-architecture); \
      VER=$(curl -s https://api.github.com/repos/ffuf/ffuf/releases/latest | grep tag_name | cut -d'"' -f4 | sed 's/v//'); \
      curl -sL "https://github.com/ffuf/ffuf/releases/download/v${VER}/ffuf_${VER}_linux_${ARCH}.tar.gz" -o /tmp/ffuf.tar.gz; \
      tar xzf /tmp/ffuf.tar.gz -C /usr/local/bin/ ffuf && chmod +x /usr/local/bin/ffuf && rm /tmp/ffuf.tar.gz; \
      # gitleaks (secret scanning — runs locally, no network). Its release assets
      # use x64/arm64 arch names, not Debian's amd64/arm64.
      ARCH=$(dpkg --print-architecture); \
      case "$ARCH" in amd64) GLARCH=x64;; arm64) GLARCH=arm64;; *) GLARCH=$ARCH;; esac; \
      VER=$(curl -s https://api.github.com/repos/gitleaks/gitleaks/releases/latest | grep tag_name | cut -d'"' -f4 | sed 's/v//'); \
      curl -sL "https://github.com/gitleaks/gitleaks/releases/download/v${VER}/gitleaks_${VER}_linux_${GLARCH}.tar.gz" -o /tmp/gitleaks.tar.gz; \
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
        curl -sL "https://raw.githubusercontent.com/danielmiessler/SecLists/master/${W}" -o "/opt/wordlists/$(basename $W)" || true; \
      done; \
    fi

COPY docker/agent-entrypoint.sh /usr/local/bin/agent-entrypoint
RUN chmod 755 /usr/local/bin/agent-entrypoint \
 && mkdir -p /workspace /home/node/.local/share/opencode \
 && chown -R node:node /workspace /home/node

USER node
COPY --chown=node:node docker/opencode.json /home/node/.config/opencode/opencode.json
# Global instructions OpenCode loads into every session: how the sandbox network works.
COPY --chown=node:node docker/agent-AGENTS.md /home/node/.config/opencode/AGENTS.md
RUN git config --global user.name "Open Runner agent" \
 && git config --global user.email "agent@open-runner.local" \
 && git config --global init.defaultBranch main

# Warm OpenCode's caches while the build still has internet, so the offline
# container never needs to download anything at runtime.
RUN SCX_PROXY_TOKEN=build timeout 25 opencode serve --hostname 127.0.0.1 --port 4096 >/tmp/warm.log 2>&1; \
    tail -n 5 /tmp/warm.log; rm -f /tmp/warm.log

# Fetch nuclei's templates now (needs internet; the runtime container has none
# by default). Harmless no-op when SECTOOLS=0.
ARG SECTOOLS=1
RUN if [ "$SECTOOLS" = "1" ] && command -v nuclei >/dev/null; then \
      nuclei -update-templates 2>/dev/null || true; \
    fi
ENV SECLISTS_DIR=/opt/wordlists

WORKDIR /workspace
EXPOSE 4096
ENTRYPOINT ["agent-entrypoint"]
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
