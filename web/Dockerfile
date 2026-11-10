FROM node:26-alpine AS base
RUN npm install -g pnpm@11
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY web/package.json web/
COPY packages/schema/package.json packages/schema/
RUN pnpm install --frozen-lockfile --filter web --filter @second-brain/schema

FROM base AS build
COPY --from=deps /app /app
COPY tsconfig.base.json ./
COPY packages/schema packages/schema
COPY web web
RUN pnpm --filter web build

# Static Go binary; copied into the runtime image below.
FROM quay.io/oauth2-proxy/oauth2-proxy:v7.15.4 AS oauth2-proxy

FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=oauth2-proxy /bin/oauth2-proxy /usr/local/bin/oauth2-proxy
COPY --from=build /app/web/.next/standalone ./
COPY --from=build /app/web/.next/static ./web/.next/static
COPY --from=build /app/web/public ./web/public
# GitLab→Jira project mapping, needed for one-click issue creation (task 5.8).
COPY config/jira-sync.json config/jira-sync.json
ENV JIRA_SYNC_CONFIG=/app/config/jira-sync.json
COPY --chmod=755 web/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
EXPOSE 3000
USER node
# Google SSO gate (the app's sole IdP): oauth2-proxy terminates all traffic
# on port 3000 and proxies authenticated requests to Next.js on loopback
# port 3001. The app derives user identity from X-Forwarded-Email.
CMD ["docker-entrypoint.sh"]
