# Operations and verification

## Environment

| Variable               | Meaning                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | Required PostgreSQL URL for a **dedicated database**, using `public` for Prisma models. Both migrations and runtime use it. |
| `PORT`                 | HTTP listen port, default 3000; `.env.example` uses 3006 on the host.                                                       |
| `AUTH_MODE`            | `jwks` (default) or `hs256`.                                                                                                |
| `JWKS_URL`             | Required HTTPS URL in JWKS mode; only RS256 is accepted.                                                                    |
| `AUTH_SECRET`          | At least 32 characters in HS256 mode; only HS256 is accepted.                                                               |
| `VALID_ISSUERS`        | Required comma-separated exact JWT issuers. Unlike some older APIs, this setting is not a JSON array.                       |
| `AUTH_AUDIENCE`        | Required expected JWT audience.                                                                                             |
| `AUTH_CLAIM_NAMESPACE` | Exact roles/userId custom-claim prefix; default `https://topcoder.com/`.                                                    |
| `CORS_ORIGINS`         | Comma-separated exact HTTP(S) origins, no trailing slash/wildcard. Empty means no browser origins are allowed.              |
| `THROTTLE_LIMIT`       | Requests per minute per client IP and handler, per replica; default 30. Health probes are exempt.                           |
| `TRUST_PROXY_CIDRS`    | Explicit trusted ingress proxy addresses/CIDRs. Empty by default.                                                           |

Do not share a database with the CMS; the API's `public` schema and `forms_reporting` schema belong to this service. PostgreSQL TLS options belong in the connection URL/driver configuration. The service does not disable certificate verification.

The Prisma client uses the PostgreSQL driver adapter and generated TypeScript code. Connection URLs are configured in `prisma.config.ts`, consistent with the [Prisma 7 migration guide](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7). Client generation and compilation require no live database. Migrations and runtime require `DATABASE_URL`.

## Database access

The checked-in migrations create tables, enums, foreign keys, CHECKs, indexes, lifecycle/answer triggers, and the reporting schema. Use `pnpm migrate:deploy`; **do not use `prisma db push`**, which does not reproduce the custom integrity triggers and checks.

Run migrations with a schema-owner/migrator role. The runtime needs CRUD privileges on the service tables, type usage, and **CREATE in `forms_reporting`** because publication creates a view. It also needs SELECT privileges on the base tables referenced by those views. It does not need superuser privileges or permission to create/alter tables in `public`.

Example grants, with roles provisioned separately by your database administrator:

```sql
GRANT USAGE ON SCHEMA public TO forms_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO forms_runtime;
GRANT USAGE, CREATE ON SCHEMA forms_reporting TO forms_runtime;

-- A BI role can read views without access to the answer tables or mutation endpoints.
GRANT USAGE ON SCHEMA forms_reporting TO forms_reporter;
GRANT SELECT ON ALL TABLES IN SCHEMA forms_reporting TO forms_reporter;
ALTER DEFAULT PRIVILEGES FOR ROLE forms_runtime IN SCHEMA forms_reporting
  GRANT SELECT ON TABLES TO forms_reporter;
```

Default privileges must be configured for the actual role that creates the views. Reapply/migrate grants as tables are added. Reporting views use PostgreSQL's default view-owner permissions, so the view owner must retain SELECT access to the base tables. Do not grant the reporting role schema CREATE or base-table mutation privileges.

The API exposes no arbitrary SQL or delete endpoints. Local Compose uses its database owner for convenience; production should use distinct credentials. There are no submission bodies, tokens, or IP addresses in application logs. IP addresses are used transiently by the rate limiter. Unexpected exceptions produce a generic server error rather than Prisma query values.

## Deployment

```sh
docker build --target migrate -t forms-api-v6-migrate .
docker build --target runtime -t forms-api-v6 .
```

Run the migration image once using the deployment database URL, then roll out the runtime image with the full environment. The runtime runs as the `node` user and includes only production dependencies and compiled service code. It includes a readiness healthcheck. Docker Compose demonstrates migration-before-start ordering and persistent PostgreSQL storage.

If this Linux workstation's Docker bridge cannot resolve the package registry while host DNS works, build with host networking and then start Compose from the completed images:

```sh
docker build --network=host --target migrate -t forms-api-v6-migrate .
docker build --network=host --target runtime -t forms-api-v6-api .
docker compose up -d --no-build
```

This is a build-network workaround; the running API and database still use the normal Compose network. The final local verification used it after a bridge DNS failure during a rebuild.

Use `/v6/forms/health` for liveness and `/v6/forms/health/ready` for readiness through the shared API Gateway. The original `/v6/health` routes remain available locally. See [ECS and CircleCI deployment](../deploy/README.md) for infrastructure, migrations, release commands, and environment configuration. SIGTERM closes the Nest application and PostgreSQL pool. Runtime startup validates authentication settings and connects to the database before listening. Swagger is available without authentication and contains schemas, not submission data.

The built-in rate limiter is in memory, per handler and replica. Keep the existing ingress/shared abuse controls in place when running multiple replicas. Trust forwarded client addresses only from configured ingress proxy networks. CORS is browser policy, not authentication; anonymous forms intentionally accept unauthenticated non-browser clients too.

Supported initial fields cover text, textarea, email, integer, exact decimal, boolean, date, single-select, and multi-select. File uploads, conditional logic, branching, webhooks, and external email delivery are outside this service's initial form contract.

## Verification commands

Always run `nvm use` in this project before Node/pnpm commands. The repository includes explicit build-script approvals for Prisma, SWC, and esbuild; it disables the optional Scarf telemetry script.

```sh
nvm use
pnpm install --frozen-lockfile
pnpm prisma:validate
pnpm lint
pnpm build
pnpm typecheck
pnpm test
DATABASE_URL=postgresql://forms:forms_local@localhost:5546/forms pnpm migrate:deploy
TEST_DATABASE_URL=postgresql://forms:forms_local@localhost:5546/forms pnpm test:integration
```

`pnpm typecheck` covers the tests, scripts, and portable integration code in addition to the service. Browser tests use jsdom/React; integration tests boot the actual Nest application and PostgreSQL adapter. The Payload synchronization test makes real HTTP calls to that app. Integration tests create unique fixture names and require an explicit test URL; they do not reset databases or silently skip absent infrastructure.

The development watcher uses ts-node's `experimentalResolver` to map Prisma's generated `.js` imports to their TypeScript source files while preserving Nest decorator metadata. Production compiles those files normally with TypeScript.

For a full packaged smoke test, start Compose, check readiness, and run `pnpm demo`. Query `forms_reporting.event_interest_v1` directly to inspect the same submission used by the JSON report.

Host Payload/website rollout requires their normal integration/configuration changes and checks, described in [the integration guide](payload-integration.md). This service's tests do not claim a deployed CMS or public website has been changed.
