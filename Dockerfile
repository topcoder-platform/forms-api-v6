ARG NODE_VERSION=26.13.1
FROM node:${NODE_VERSION}-alpine AS tooling
RUN apk add --no-cache openssl ca-certificates \
    && npm install --global pnpm@11.21.0
WORKDIR /app
COPY deploy/certs/us-east-1-bundle.pem /app/deploy/certs/us-east-1-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/deploy/certs/us-east-1-bundle.pem
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tools ./tools
COPY deploy/migrate/package.json ./deploy/migrate/package.json

FROM tooling AS dependencies
RUN pnpm --filter @topcoder/forms-api-v6 install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm test:dependency-compat

FROM dependencies AS production-dependencies
RUN pnpm prune --prod

FROM tooling AS migration-dependencies
RUN pnpm --filter @topcoder/forms-migrations install --prod --frozen-lockfile \
    --virtual-store-dir=/app/deploy/migrate/node_modules/.pnpm

FROM alpine:3.24 AS runtime-base
ARG NODE_VERSION
ENV NODE_ENV=production
WORKDIR /app
RUN apk upgrade --no-cache \
    && apk add --no-cache 'libcrypto3>=3.5.9-r1' 'libssl3>=3.5.9-r1' openssl ca-certificates 'nodejs-current~26.13.1' "zlib>=1.4-r0" \
    && addgroup -S -g 10001 app \
    && adduser -S -D -u 10001 -G app app
COPY deploy/certs/us-east-1-bundle.pem /app/deploy/certs/us-east-1-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/deploy/certs/us-east-1-bundle.pem
USER app

# One-shot migration image; invoke the installed CLI without shipping npm/pnpm.
FROM runtime-base AS migrate
COPY --from=migration-dependencies --chown=app:app /app/deploy/migrate/node_modules ./node_modules
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
