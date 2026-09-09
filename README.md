# Topcoder Forms API v6

A NestJS/TypeScript service for named website forms, immutable form versions, typed PostgreSQL submissions, and reporting. Payload CMS manages editorial definitions; the API validates and owns the published schema and submission data.

**There are no JSON/JSONB database columns.** Each answer references a field in one specific form version and uses a text, integer, exact decimal, boolean, date, or relational choice value. Publishing creates a SQL view with a named column for every field:

```sql
SELECT submitted_at, email, full_name, interests, receive_updates
FROM forms_reporting.event_interest_v1
ORDER BY submitted_at;
```

This uses normalized typed answer tables and per-version reporting views. It does **not** create a new physical table for every form. The [data model and tradeoffs](docs/data-model.md) explain the distinction.

## Stack

- Node **26.8.1**, pinned in `.nvmrc` and Docker; current release verified against the [Node release listing](https://nodejs.org/en/download/current) on September 9, 2026.
- NestJS **11.1.28**, matching the other v6 services and the supported peer range of Nest Throttler.
- TypeScript **5.9.3**, strict checking and decorator metadata.
- Prisma **7.10.0**, generated TypeScript client and `@prisma/adapter-pg`.
- PostgreSQL **17**, pnpm **11.21.0**.

## Run locally

Run all commands from this project directory. Select Node before any package-manager command, including in a new terminal.

```sh
cd forms-api-v6
nvm install
nvm use
npm install --global pnpm@11.21.0
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up --build -d
```

API: `http://localhost:3006/v6/forms`. OpenAPI UI: `http://localhost:3006/v6/forms/api-docs`. Readiness: `http://localhost:3006/v6/forms/health/ready`.

Compose runs migrations as a separate job before starting the non-root API container. Its credentials and localhost bindings are for development. `FORMS_HTTP_PORT` and `FORMS_DATABASE_PORT` change host ports.

Create/publish an example form, submit a sample, and print its report:

```sh
nvm use
pnpm demo
```

The demo signs a short-lived local token internally and does not print it. It requires local HS256 configuration and refuses `NODE_ENV=production`. Each demo run intentionally creates one new sample submission; repeat form registration/publication is idempotent.

For local source development with only PostgreSQL in Docker:

```sh
docker compose up -d postgres
nvm use
pnpm migrate:deploy
pnpm build
pnpm start:dev
```

Stop the Compose API first if it already occupies port 3006. `pnpm start:dev` uses TypeScript decorator metadata and watches imported source files. `pnpm start:prod` runs the compiled build.

## Workflow

1. Register a stable key such as `event_interest`.
2. Save revision 1 with its named fields and types.
3. Publish it. The API creates `forms_reporting.event_interest_v1` transactionally.
4. Add a Payload form block referencing `event_interest` to a content page.
5. The website fetches the current API schema and submits the exact displayed revision with a UUID `Idempotency-Key`.
6. Read private paginated JSON/CSV reports or query the SQL view with a reporting database role.

Published definitions are immutable. Changes use a new sequential revision; publication retires the previous one. An already-open older page receives a 409 and must reload. Historical reports remain available. Exact retries of accepted submissions return the original receipt, including after retirement.

Anonymous and signed-in member access are configurable per form. Member identity comes from a verified Topcoder JWT, never a submitted `memberId`. Machine tokens manage forms and read reports through separate scopes; they cannot submit visitor forms.

## Integrations and documentation

- [Payload CMS and website integration](docs/payload-integration.md): typed collection, admin sync button, reusable block, and React renderer.
- [API contract](docs/api.md): routes, field types, validation, authentication, and retry behavior.
- [Data model and reporting](docs/data-model.md): foreign keys, database checks, SQL views, versioning, and example queries.
- [Operations](docs/operations.md): environment, database permissions, deployment, and verification.
- [Example definition](examples/event-interest.json).

The portable integrations live inside this service. Register them in the host Payload configuration and website renderer as documented. The existing `payload-cms` and `topcoder-website` repositories have not been changed or deployed by this project.

## Verify

```sh
nvm use
pnpm lint
pnpm build
pnpm typecheck
pnpm test
```

Integration tests require an explicitly selected disposable database, migrated with this project's migrations. They never silently skip database checks or reset a database. They create uniquely named fixtures and leave them for inspection.

```sh
nvm use
DATABASE_URL=postgresql://forms:forms_local@127.0.0.1:5546/forms pnpm migrate:deploy
TEST_DATABASE_URL=postgresql://forms:forms_local@127.0.0.1:5546/forms pnpm test:integration
```

Coverage includes actual PostgreSQL writes, all field types, SQL views, CSV output, concurrent idempotency, immutable versions, JWT access, required-answer/ownership constraints, Payload synchronization over HTTP, and browser rendering/retry behavior. CI executes the same checks with PostgreSQL 17.
