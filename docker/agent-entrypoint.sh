#!/bin/sh
# OpenCode records file changes only inside git repositories, so make sure the
# workspace root is one (projects created inside it are tracked from day one).
set -e
if [ ! -d /workspace/.git ]; then
  git -C /workspace init -q
  git -C /workspace commit -q --allow-empty -m "workspace created"
fi

# Inline config, merged by OpenCode over opencode.json:
#
# - OPENROUTER_MODELS (comma list of OpenRouter ids) becomes an `openrouter`
#   provider that calls back through the runner's key-injecting proxy, so the
#   OpenRouter key never enters this container. Limits are conservative
#   defaults; the runner serves the real ones to the Playground.
# - RECON_EXECUTOR_MODEL / RECON_TRIAGE_MODEL / RECON_VERIFY_MODEL /
#   RECON_ESCALATE_MODEL ("provider/model") replace the model of that recon
#   agent. opencode.json ships them on open-weight models, so recon works with
#   no Anthropic key; set these (the same values the runner gets) to put a role
#   on Claude.
if [ -n "${OPENROUTER_MODELS:-}${RECON_EXECUTOR_MODEL:-}${RECON_TRIAGE_MODEL:-}${RECON_VERIFY_MODEL:-}${RECON_ESCALATE_MODEL:-}" ]; then
  OPENCODE_CONFIG_CONTENT=$(node -e '
    const env = process.env, cfg = {};
    const ids = (env.OPENROUTER_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length) {
      const models = Object.fromEntries(ids.map((id) => [id, { name: id, limit: { context: 128000, output: 16000 } }]));
      cfg.provider = { openrouter: {
        npm: "@ai-sdk/openai-compatible", name: "OpenRouter",
        options: { baseURL: "http://runner:8790/openrouter/v1", apiKey: env.SCX_PROXY_TOKEN },
        models,
      } };
    }
    const roles = { recon: "RECON_EXECUTOR_MODEL", "recon-triage": "RECON_TRIAGE_MODEL", "recon-verify": "RECON_VERIFY_MODEL", "recon-escalate": "RECON_ESCALATE_MODEL" };
    for (const [agent, key] of Object.entries(roles)) {
      const model = (env[key] || "").trim();
      if (model) (cfg.agent ??= {})[agent] = { model };
    }
    process.stdout.write(JSON.stringify(cfg));
  ')
  export OPENCODE_CONFIG_CONTENT
fi
exec "$@"
