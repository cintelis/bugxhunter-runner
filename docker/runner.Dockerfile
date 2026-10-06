# Open Runner — web UI + API container. Holds the SCX key, serves the login and
# the built web app, and proxies the agent's model calls to SCX.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY server server
COPY web web
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8790
COPY --from=build --chown=node:node /app /app
# /data holds the saved internet-access rules (a volume in docker-compose.yml).
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8790
CMD ["node", "--import", "tsx", "server/src/index.ts"]
