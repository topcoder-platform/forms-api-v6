# ECS and CircleCI deployment

`service.yaml` creates the `forms-api-v6` Fargate service on the existing
`topcoder-infrastructure` cluster. It owns ECR, task/execution roles, CloudWatch
logs, private task networking, RDS ingress, ALB target group/rule, and both HTTP
API Gateway routes (`/v6/forms` and `/v6/forms/{proxy+}`). The existing gateway VPC
link, TLS integration, CloudFront origin authorizer, and domain remain shared.

The runtime listens on port 3000. Health checks use `/v6/forms/health/ready` and
require database availability. OpenAPI UI is `/v6/forms/api-docs`, with JSON at
`/v6/forms/api-docs-json`. The root forms list requires an administrator token;
published schemas and anonymous submissions are public.

## Initial environment setup

Dev uses schema `forms` in database `topcoder-services` on the existing services RDS instance. The database administrator provisions the `forms` login and schema; this service does not create a separate database or rotate that login. All tables, enums, functions, reporting views, and Prisma migration history remain in `forms`.

Load the dev AWS credentials and the administrator-provided `FORMS_DB_USERNAME` / `FORMS_DB_PASSWORD` into the environment. `python3 deploy/bootstrap-dev.py` checks the existing connection and schema ownership without writes. Once the target schema is migrated and its existing data has been copied, `python3 deploy/bootstrap-dev.py --apply` selects it in the encrypted `DATABASE_URL` and `MIGRATION_DATABASE_URL` parameters under `/config/forms-api-v6/appvar`. Both URLs use the supplied `forms` login, `schema=forms`, and certificate-verified TLS. The script preserves the existing authentication settings.

For a new environment, create the CloudFormation stack with `DesiredCount=0`, configure the equivalent database/schema/login and encrypted settings, run the migrations, then release the runtime. Production uses `forms-api-v6-production` with `Environment=production`, production networking/gateway parameters, CORS origins, and credentials. Template defaults describe dev and must be overridden for production. The bootstrap script intentionally refuses another AWS account.

## Moving the original dev data

The original `forms` database is preserved as a recovery copy. Its three applied migrations are archived unchanged in `prisma/legacy-migrations`; current `prisma/migrations` contains a fresh baseline for schema `forms`. Do not run the new baseline against the old installation as an in-place upgrade.

1. Migrate the empty target schema using the new login and `schema=forms`.
2. Pause the Forms ECS service and wait for its tasks to stop before the final data copy.
3. With `boto3` and `psycopg[binary]` installed, run `python3 deploy/copy-dev-data.py --apply`. It copies the seven service tables in one transaction, preserving every ID, version, timestamp, answer, and idempotency key. It recreates each reporting view in `forms` and verifies all table/view contents against the source. The copy tool temporarily disables only application triggers inside this transaction, retaining foreign keys and CHECKs, and re-enables them before commit.
4. Select the new encrypted URLs with `bootstrap-dev.py --apply` and release the matching runtime. Confirm readiness, the published schema, and a real browser submission against `forms.event_interest_v1`.

The copy refuses a nonempty target. The source is retained and fenced against further application writes at cutover. A rollback requires stopping the new service, restoring the prior URLs/image, and explicitly reconciling any new submissions before restoring source writes. Never switch back after accepting new data without reconciliation.

## Releases

`.circleci/config.yml` runs lint, build, type checks, unit tests, migrations, and
real-PostgreSQL integration tests. After verification, `develop` deploys dev and
`master` deploys production. Both use Topcoder's `org-global` context and pinned
`tc-deploy-scripts` credential helper, matching the other services. Deployments are
serialized separately per environment. The CircleCI project must be connected in
the Topcoder organization to use that shared context.

The same release command can run from an authorized workstation:

```sh
nvm use
pnpm lint && pnpm build && pnpm test
docker build --target migrate -t forms-api-v6:migrate-candidate .
docker build --target runtime -t forms-api-v6:candidate .
python3 -u deploy/release.py dev dev-UNIQUE_RELEASE_TAG
```

Use `--network=host` for local Docker builds if the workstation bridge cannot
resolve the registry. `release.py` requires boto3 and Docker and checks account and
stack environment before pushing. Runtime and migration images receive immutable
release tags. The migration task runs in the same private subnets as the service,
uses the configured schema-owner login, and applies only the schema-scoped migrations.
Only exit code zero permits CloudFormation promotion. ECS keeps the previous task
healthy during rollout and uses its deployment circuit breaker to roll back failed
runtime starts. Database migrations must remain compatible with the previous
runtime; the service rollback does not undo data/schema migrations.

The script writes `release-dev.json` or `release-production.json` containing image
digests and AWS task/stack identifiers. On an observation timeout, inspect the
reported task/stack operation before retrying; do not start a second migration
while the first remains active. Infrastructure edits are applied separately using
CloudFormation with the current ImageTag and environment parameters preserved;
normal app releases retain the existing stack template and parameters.

## Dev sample

`python3 deploy/seed-dev.py` publishes `event_interest` from
`examples/event-interest.json`, using a short-lived bootstrap token held in memory.
It refuses production and conflicting published definitions. The corresponding
CMS seed lives in `payload-cms/scripts/seed-forms-test.ts`. The website resolves the
CMS page at `/forms-test` and fetches its schema from the public Forms API at runtime.
