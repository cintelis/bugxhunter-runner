# BugXHunter through Sigilant: the tools behind a gateway (`serve-tools.ts`)
# and the bridge the agent talks to (`serve-bridge.ts`, the default). Node 24,
# which the gateway's post-quantum TLS needs. The SDK comes built from an
# image of Sigilant's that carries it (its fleet image does, at
# /app/node_modules/@sigilant/sdk). Build from the repository root:
#
#   docker build -f sigilant/Dockerfile --build-arg SIGILANT_SDK_IMAGE=sigilant-fleet:local -t bugxhunter-sigilant .

ARG SIGILANT_SDK_IMAGE=sigilant-fleet:local
FROM ${SIGILANT_SDK_IMAGE} AS sdk

FROM node:24-trixie-slim
WORKDIR /app
COPY --from=sdk /app/node_modules/@sigilant/sdk ./node_modules/@sigilant/sdk
RUN mkdir -p /findings && chown node:node /findings
COPY sigilant/package.json sigilant/mcp.ts sigilant/tools.ts sigilant/bridge.ts sigilant/github-app.ts sigilant/identity.ts sigilant/usage.ts sigilant/serve-tools.ts sigilant/serve-bridge.ts sigilant/run.ts sigilant/webhook.ts sigilant/serve-webhook.ts ./sigilant/
USER node
CMD ["node", "sigilant/serve-bridge.ts"]
