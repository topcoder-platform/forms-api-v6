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

For dev, load AWS credentials into the environment, then run:

```sh
python3 deploy/bootstrap-dev.py --apply
aws cloudformation deploy --stack-name forms-api-v6-dev \
  --template-file deploy/service.yaml --capabilities CAPABILITY_IAM \
  --parameter-overrides BootstrapOnly=false DesiredCount=0
```

The database bootstrap uses the existing RDS administrative connection from SSM
and creates only the dedicated `forms` database, `forms_migrator`, `forms_runtime`,
and four encrypted settings under `/config/forms-api-v6/appvar`. Passwords are
random and existing passwords are retained. PostgreSQL TLS validates the AWS RDS
certificate through the checked-in regional trust bundle. Runtime cannot modify
base-table schemas or migration history; publication can create reporting views.

For production, provision the same dedicated database/logins and encrypted
`DATABASE_URL`, `MIGRATION_DATABASE_URL`, `VALID_ISSUERS` (comma-separated), and
`AUTH_AUDIENCE` in the production account. `AUTH_SECRET` references that account's
existing common setting. Create `forms-api-v6-production` with `Environment=production`,
production VPC/subnets/security groups/listener/gateway IDs and production CORS
origins. Template defaults describe dev and must be overridden for production.
The dev bootstrap intentionally refuses another account.

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
uses its own database login, and reapplies `grant-runtime.sql` after migrations.
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
