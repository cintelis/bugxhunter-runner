# BugXHunter — web UI + API container. Holds the keys (vault), serves the
# sign-in and the built web app, proxies the agent's model calls, and clones
# GitHub repositories into the shared workspace.
#
# Stage 1 compiles both workspaces; stage 2 ships only the compiled output and
# production dependencies (no TypeScript, tsx or Vite at runtime).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY shared shared
COPY server server
COPY web web
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8790
# git: the GitHub integration clones into /workspace from here, so the token
# never enters the agent container.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/server/dist server/dist
COPY --from=build --chown=node:node /app/web/dist web/dist
# /logs holds the audit log and /data the sealed key vault (both their own
# volumes in docker-compose.yml, neither visible to the agent).
RUN mkdir -p /logs /data && chown node:node /logs /data
USER node
EXPOSE 8790
CMD ["node", "server/dist/index.js"]
