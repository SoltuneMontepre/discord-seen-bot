# syntax=docker/dockerfile:1
# Build stage: install production deps (better-sqlite3 is a native module).
FROM node:24-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Runtime stage: no build step — Node 24 runs the TypeScript sources via native type stripping.
FROM node:24-slim
ENV NODE_ENV=production \
    DATABASE_PATH=/data/seen.db
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
# /data must be a bind mount onto host storage that is ENCRYPTED AT REST (see README).
# A Docker/Podman named volume is not encrypted by itself.
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "src/main.ts"]
