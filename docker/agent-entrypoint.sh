#!/bin/sh
# OpenCode records file changes only inside git repositories, so make sure the
# workspace root is one (projects created inside it are tracked from day one).
set -e
if [ ! -d /workspace/.git ]; then
  git -C /workspace init -q
  git -C /workspace commit -q --allow-empty -m "workspace created"
fi

# OPENROUTER_MODELS (comma list of OpenRouter ids) becomes an `openrouter`
# provider that calls back through the runner's key-injecting proxy, so the
# OpenRouter key never enters this container. OpenCode merges this inline
# config over opencode.json. Limits are conservative defaults; the runner
# serves the real ones to the Playground.
if [ -n "${OPENROUTER_MODELS:-}" ]; then
  OPENCODE_CONFIG_CONTENT=$(node -e '
    const ids = (process.env.OPENROUTER_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const models = Object.fromEntries(ids.map((id) => [id, { name: id, limit: { context: 128000, output: 16000 } }]));
    process.stdout.write(JSON.stringify({ provider: { openrouter: {
      npm: "@ai-sdk/openai-compatible", name: "OpenRouter",
      options: { baseURL: "http://runner:8790/openrouter/v1", apiKey: process.env.SCX_PROXY_TOKEN },
      models,
    } } }));
  ')
  export OPENCODE_CONFIG_CONTENT
fi
exec "$@"
