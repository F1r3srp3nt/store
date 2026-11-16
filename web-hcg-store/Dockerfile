# HCG Store: storefront and server in one image. The server serves the built storefront (dist/)
# and the account API on the same origin. Deployed to Fly.io (fly.toml); any container host works.
# No secrets are baked in: they come from the host's secret store at runtime.

FROM node:22.23.4-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Stamped into hcg-build.json so the deployed commit can be checked (scripts/smoke-deployment.mjs).
ARG GITHUB_SHA=""
ENV GITHUB_SHA=${GITHUB_SHA} \
    VITE_DEPLOY_ENV=production \
    VITE_PUBLIC_ORIGIN=https://store.hakmicapitalgroup.com
RUN npm run build

FROM node:22.23.4-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/server-dist ./server-dist
COPY catalogue ./catalogue
COPY server/data ./server/data
# /data is the persistent volume (SQLite database). The server runs as the unprivileged "node" user.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "server-dist/main.mjs"]
