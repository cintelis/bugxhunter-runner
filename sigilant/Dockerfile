# BugXHunter through Sigilant: the tools behind a gateway (`serve-tools.ts`)
# and the bridge the agent talks to (`serve-bridge.ts`, the default). Node 24,
# which the gateway's post-quantum TLS needs. Build from the repository root,
# with a Sigilant checkout as a named context, from which the SDK is built:
#
#   docker build -f sigilant/Dockerfile --build-context sigilant=../sigilant -t bugxhunter-sigilant .

FROM node:24-trixie-slim AS sdk
RUN npm install --global pnpm@11.9.0
WORKDIR /src
COPY --from=sigilant package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY --from=sigilant apps ./apps
COPY --from=sigilant sdks/typescript ./sdks/typescript
COPY --from=sigilant demo ./demo
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @sigilant/sdk build

FROM node:24-trixie-slim
WORKDIR /app
COPY --from=sdk /src/sdks/typescript/package.json ./node_modules/@sigilant/sdk/package.json
COPY --from=sdk /src/sdks/typescript/dist ./node_modules/@sigilant/sdk/dist
RUN mkdir -p /findings && chown node:node /findings
COPY sigilant/package.json sigilant/mcp.ts sigilant/tools.ts sigilant/bridge.ts sigilant/serve-tools.ts sigilant/serve-bridge.ts ./sigilant/
USER node
CMD ["node", "sigilant/serve-bridge.ts"]
