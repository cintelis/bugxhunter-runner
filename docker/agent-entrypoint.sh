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
# - BEDROCK_MODELS (comma list of Amazon Bedrock model or inference-profile
#   ids) becomes a `bedrock` provider the same way. The runner signs the
#   upstream call with its AWS credentials (or injects its Bedrock API key), so
#   this container holds neither.
# - RECON_EXECUTOR_MODEL / RECON_TRIAGE_MODEL / RECON_VERIFY_MODEL /
#   RECON_ESCALATE_MODEL ("provider/model") replace the model of that recon
#   agent. opencode.json ships them on open-weight models, so recon works with
#   no Anthropic key; set these (the same values the runner gets) to put a role
#   on Claude.
if [ -n "${OPENROUTER_MODELS:-}${BEDROCK_MODELS:-}${RECON_EXECUTOR_MODEL:-}${RECON_TRIAGE_MODEL:-}${RECON_VERIFY_MODEL:-}${RECON_ESCALATE_MODEL:-}" ]; then
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
    // The hosted OpenAI GPT models are left out: the Bedrock chat route refuses tools for
    // them, and the agent cannot work without tools. They stay available in the Playground.
    // (No apostrophes in this script: it sits inside a single-quoted shell string, and one
    // ends it, so node runs only what comes before and prints nothing.)
    const bedrock = (env.BEDROCK_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean)
      .filter((id) => !/(^|\.)openai\.gpt-(?!oss)/.test(id));
    if (bedrock.length) {
      // GLM 5.3 is 1M in, 128K out; anything else gets the conservative default.
      const glm = /^(global|us)\.zai\.glm-5\.3$/;
      const models = Object.fromEntries(bedrock.map((id) => [id, glm.test(id)
        ? { name: "GLM 5.3 (Bedrock)", limit: { context: 1000000, output: 128000 } }
        : { name: id, limit: { context: 128000, output: 16000 } }]));
      (cfg.provider ??= {}).bedrock = {
        npm: "@ai-sdk/openai-compatible", name: "Amazon Bedrock",
        options: { baseURL: "http://runner:8790/bedrock/v1", apiKey: env.SCX_PROXY_TOKEN },
        models,
      };
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
