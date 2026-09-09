FROM node:26.8.1-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.21.0
WORKDIR /app
COPY deploy/certs/us-east-1-bundle.pem /app/deploy/certs/us-east-1-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/deploy/certs/us-east-1-bundle.pem

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm build

# Separate one-shot migration image: runtime does not ship the Prisma CLI or CMS dev dependencies.
FROM build AS migrate
CMD ["pnpm", "migrate:deploy"]

FROM dependencies AS production-dependencies
RUN pnpm prune --prod

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/src ./dist/src
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v6/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/src/main.js"]
