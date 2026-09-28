# Operations and verification

## Environment

| Variable               | Meaning                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | Required PostgreSQL URL with `schema=forms`; dev uses `topcoder-services`. Both migrations and runtime use it. |
| `PORT`                 | HTTP listen port, default 3000; `.env.example` uses 3006 on the host.                                                       |
| `AUTH_SECRET`          | Required shared Topcoder secret, at least 32 characters; used for HS256 tokens.                                                               |
| `VALID_ISSUERS`        | Required exact trusted JWT issuers, as a JSON string array or comma-separated list. RS256 JWKS URLs derive from these issuers.                       |
| `AUTH_CLAIM_NAMESPACE` | Actor fallback prefix, default `https://topcoder.com/`; the shared middleware normalizes Topcoder namespaces first.                                                    |
| `CORS_ORIGINS`         | Comma-separated exact HTTP(S) origins, no trailing slash/wildcard. Empty means no browser origins are allowed.              |
| `THROTTLE_LIMIT`       | Requests per minute per client IP and handler, per replica; default 30. Health probes are exempt.                           |
| `TRUST_PROXY_CIDRS`    | Explicit trusted ingress proxy addresses/CIDRs. Empty by default.                                                           |

Inbound authentication uses the pinned `tc-core-library-js` authenticator for both HS256 and RS256. For the dev reports application, `VALID_ISSUERS` must include `https://auth.topcoder-dev.com/` exactly (including the trailing slash); its public signing keys are fetched from `https://auth.topcoder-dev.com/.well-known/jwks.json`. Keep the legacy API issuer and other intended trusted issuers in the same list. The runtime needs outbound HTTPS access to those JWKS endpoints.

`AUTH_MODE`, `AUTH_AUDIENCE`, and `JWKS_URL` are obsolete and ignored, so an existing ECS task definition with `AUTH_MODE=hs256` does not block RS256 after deploying the new image. The updated template removes these obsolete mappings. The library does not enforce a Forms-specific audience; the Topcoder browser client ID is accepted through the same trusted-issuer policy as other v6 services. No browser token, client secret, or private signing key needs to be copied into Forms configuration.

All Forms tables, enums, functions, migration history, and reporting views live in the `forms` schema. The database can be shared with other services. Models and raw SQL explicitly qualify this schema; migrations do not change other schemas. PostgreSQL TLS options belong in the connection URL/driver configuration. The service does not disable certificate verification.

The Prisma client uses the PostgreSQL driver adapter and generated TypeScript code. Connection URLs are configured in `prisma.config.ts`, consistent with the [Prisma 7 migration guide](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7). Client generation and compilation require no live database. Migrations and runtime require `DATABASE_URL`.

## Outbound Bus API

Ordinary submissions need no Bus API configuration. To accept `kafka=true` submissions successfully, configure:

| Variable | Meaning |
| --- | --- |
| `BUSAPI_URL` | HTTP(S) API base ending in `/v6`, e.g. `https://api.topcoder-dev.com/v6`. The shared wrapper appends `/bus/events`. |
| `AUTH0_URL` | Auth0 token endpoint used by the shared Topcoder M2M client. |
| `AUTH0_AUDIENCE` | Outbound M2M audience used to acquire a Bus API token. |
| `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` | Service credentials authorized to publish Bus API events. Required when `BUSAPI_URL` is set. |
| `TOKEN_CACHE_TIME` | Optional M2M token cache duration in milliseconds, 0–86400000; otherwise uses the wrapper default. |
| `AUTH0_PROXY_SERVER_URL` | Optional Auth0 proxy supported by the shared wrapper. |
| `KAFKA_ERROR_TOPIC` | Wrapper error-topic setting, default `common.error.reporting`; submission topic is always `form.submitted`. |

For ECS, expose the five required Bus API/Auth0 settings to the runtime container through its task-definition secrets (the existing template only maps inbound authentication and database settings). Store them under the service parameter prefix so its existing SSM read permissions apply; never put credentials in the template.

Apply migration `20260928010000_submission_events` before deploying this version. It adds the `forms.SubmissionEvent` delivery table; it does not change existing submissions or reporting views. The service role needs SELECT/INSERT/UPDATE on this table. Ensure `form.submitted` is available through Bus API and downstream consumers deduplicate on the payload's `submissionId`.

Delivery failures return 503 after saving the submission; callers must retry the same body and key. Pending attempts have `publishedAt IS NULL` in `forms.SubmissionEvent`. No background delivery job is included. Provider error bodies, credentials, and answers are not logged by the publisher. Delivery uses a separate transaction with a row lock and a 15-second transaction timeout; failure to record an accepted event may result in redelivery.

The shared wrapper and its Topcoder core dependency are pinned to Git commits. `pnpm-workspace.yaml` allows Git subdependencies for this integration and explicitly skips optional native DTrace builds.

## Database access

The checked-in migrations create tables, enums, foreign keys, CHECKs, indexes, and lifecycle/answer triggers inside `forms`. Use `pnpm migrate:deploy`; **do not use `prisma db push`**, which does not reproduce the custom integrity triggers and checks.

Dev uses the administrator-provided `forms` login, which owns the `forms` schema, for both migrations and runtime. Publication creates a view in this schema. The implementation does not require access to other services' tables or CREATE privileges in `public`. TLS verifies the RDS certificate using the checked-in regional CA bundle.

To allow a separately provisioned reporting role to read a published view:

```sql
GRANT USAGE ON SCHEMA forms TO forms_reporter;
GRANT SELECT ON forms.event_interest_v1 TO forms_reporter;
```

Grant each reporting view explicitly. Views use PostgreSQL's default view-owner permissions, so the owner must retain SELECT access to their base tables. The API exposes no arbitrary SQL or delete endpoints. Application logs omit submission bodies, tokens, and IP addresses; IP addresses are used transiently by the rate limiter.

`prisma/migrations` contains the baseline for this schema. `prisma/legacy-migrations` preserves the original dedicated-database migration history for recovery; it is not executed by current releases. Existing installations require an explicit data copy, not merely a connection URL change. See the [dev migration procedure](../deploy/README.md#moving-the-original-dev-data).

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

Use `/v6/health` for local liveness and `/v6/forms/health/ready` for readiness through the shared API Gateway. The original `/v6/health/ready` route remains available locally. There is no liveness route at `/v6/forms/health`, so `health` remains a usable form key. See [ECS and CircleCI deployment](../deploy/README.md) for infrastructure, migrations, release commands, and environment configuration. SIGTERM closes the Nest application and PostgreSQL pool. Runtime startup validates authentication settings and connects to the database before listening. Swagger is available without authentication and contains schemas, not submission data.

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
DATABASE_URL=postgresql://forms:forms_local@localhost:5546/forms?schema=forms pnpm migrate:deploy
TEST_DATABASE_URL=postgresql://forms:forms_local@localhost:5546/forms?schema=forms pnpm test:integration
```

`pnpm typecheck` covers the tests, scripts, and portable integration code in addition to the service. Browser tests use jsdom/React; integration tests boot the actual Nest application and PostgreSQL adapter. The Payload synchronization test makes real HTTP calls to that app. Integration tests create unique fixture names and require an explicit test URL; they do not reset databases or silently skip absent infrastructure.

The development watcher uses ts-node's `experimentalResolver` to map Prisma's generated `.js` imports to their TypeScript source files while preserving Nest decorator metadata. Production compiles those files normally with TypeScript.

For a full packaged smoke test, start Compose, check readiness, and run `pnpm demo`. Query `forms.event_interest_v1` directly to inspect the same submission used by the JSON report.

Host Payload/website rollout requires their normal integration/configuration changes and checks, described in [the integration guide](payload-integration.md). This service's tests do not claim a deployed CMS or public website has been changed.
