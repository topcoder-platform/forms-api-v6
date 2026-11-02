ARG NODE_VERSION=26.12.1
FROM node:${NODE_VERSION}-alpine AS dependencies
RUN apk add --no-cache openssl ca-certificates \
    && npm install --global pnpm@11.21.0
WORKDIR /app
COPY deploy/certs/us-east-1-bundle.pem /app/deploy/certs/us-east-1-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/deploy/certs/us-east-1-bundle.pem
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tools ./tools
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm test:dependency-compat

FROM dependencies AS production-dependencies
RUN pnpm prune --prod

FROM alpine:3.24 AS runtime-base
ARG NODE_VERSION
ENV NODE_ENV=production
WORKDIR /app
RUN apk upgrade --no-cache \
    && apk add --no-cache openssl ca-certificates "nodejs-current~${NODE_VERSION%%.*}" \
    && addgroup -S -g 10001 app \
    && adduser -S -D -u 10001 -G app app
COPY deploy/certs/us-east-1-bundle.pem /app/deploy/certs/us-east-1-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/deploy/certs/us-east-1-bundle.pem
USER app

# One-shot migration image; invoke the installed CLI without shipping npm/pnpm.
FROM runtime-base AS migrate
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json prisma.config.ts ./
COPY --chown=app:app prisma ./prisma
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

FROM runtime-base AS runtime
COPY --from=production-dependencies --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist/src ./dist/src
COPY --chown=app:app package.json ./
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v6/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/src/main.js"]
