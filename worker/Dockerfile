FROM node:26-alpine AS base
RUN npm install -g pnpm@11
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY worker/package.json worker/
COPY packages/schema/package.json packages/schema/
RUN pnpm install --frozen-lockfile --filter worker --filter @second-brain/schema --prod

FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app /app
COPY tsconfig.base.json ./
COPY config config
COPY packages/schema packages/schema
COPY worker worker
USER node
# Run from the worker package so pnpm's strict node_modules layout resolves tsx.
WORKDIR /app/worker
CMD ["node", "--import", "tsx", "src/index.ts"]
