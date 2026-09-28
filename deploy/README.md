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

Inbound JWT handling uses the same `tc-core-library-js` middleware as the other v6 APIs. Both legacy HS256 and Auth0 RS256 tokens are supported in one deployment. The Forms `VALID_ISSUERS` parameter must contain `https://auth.topcoder-dev.com/` for dev browser sign-in; the library resolves its JWKS and normalizes the dev namespaced roles/user ID. Existing `AUTH_MODE` and `AUTH_AUDIENCE` task settings are ignored by the new runtime. Updating the application image is sufficient when the issuer is already allowed; otherwise update the issuer parameter and roll the tasks as well. See [authentication configuration](../docs/operations.md#environment).

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

`.circleci/config.yml` uses the same pinned `tc-deploy-scripts` v1.4.20 flow as
`bus-api-v6`: `awsconfiguration.sh` loads credentials, `psvar-processor.sh` loads
`/config/forms-api-v6/deployvar`, and `master_deploy.sh` publishes the runtime image
and updates ECS with service/global SSM secret references. `develop` deploys dev;
`master` deploys production. Both use the Topcoder `org-global` context and are
serialized separately per environment.

Docker builds the runtime as `forms-api-v6:latest` and a separate migration image.
The existing `release.py` now only pushes and runs the migration image in the
service's private subnets, using `MIGRATION_DATABASE_URL` as its sole secret.
It clones the service's current task definition and records the migration image
digest and task ARN in `deploy/release-<environment>.json`. A nonzero migration
exit stops the job before `master_deploy.sh` can deploy the runtime. On timeout,
inspect the reported migration task before retrying.

The runtime deployment command is the standard shared invocation:

```sh
./master_deploy.sh -d ECS -e DEV -t latest \
  -j "/config/${APPNAME}/appvar,/config/common/global-appvar" \
  -i "$APPNAME" -p FARGATE
```

The shared script tags the runtime image with `CIRCLE_BUILD_NUM`, registers the
ECS task definition, updates the existing service, and checks rollout status.
Its Fargate template uses the shared `ecsTaskExecutionRole` and writes logs to
`/aws/ecs/<cluster>` with the deployment environment as stream prefix. Ensure
that role can read both SSM prefixes (and decrypt any custom KMS key).
The service's ALB readiness checks and deployment circuit breaker remain in place.
Database migrations must remain compatible with the previous runtime; service
rollback does not undo schema or data migrations.

Provision `/config/forms-api-v6/deployvar` before the first release in each account:

| Parameter | Value |
| --- | --- |
| `AWS_REPOSITORY`, `AWS_ECS_SERVICE`, `AWS_ECS_TASK_FAMILY`, `AWS_ECS_CONTAINER_NAME` | `forms-api-v6` |
| `AWS_ECS_CLUSTER` | Existing cluster, e.g. `topcoder-infrastructure` |
| `AWS_ECS_PORTS` | `3000:3000:tcp` |
| `AWS_ECS_FARGATE_CPU`, `AWS_ECS_FARGATE_MEMORY` | `512`, `1024` for the current Forms task size |
| `AWS_ECS_CONTAINER_CPU`, `AWS_ECS_CONTAINER_MEMORY_RESERVATION` | `0`, `512` |
| `AWS_ECS_READONLY_ROOTFILESYSTEM` | `true` |
| `AWS_ECS_TASK_ROLE_ARN` | Existing Forms task role **name**, without its ARN prefix |
| `AWS_ECS_CONTAINER_HEALTH_CMD` | Readiness command, with double quotes escaped for `psvar-processor.sh`'s shell export format |

Move runtime environment settings into service appvars: `NODE_ENV=production`,
`PORT=3000`, `AWS_REGION=us-east-1`, and the environment's existing `CORS_ORIGINS`
and `TRUST_PROXY_CIDRS`. The shared template obtains runtime settings from SSM,
not from the previous CloudFormation task definition. Production requires its own
origins, credentials, task role, and deployvars.

Local verification:

```sh
nvm use
pnpm lint && pnpm build && pnpm test
```

CloudFormation remains responsible for infrastructure. Application releases now
update the ECS service directly, as in the other v6 services; the stack's ImageTag
and TaskDefinition output no longer track the active application release. When
changing infrastructure, preserve the live service task definition to avoid
restoring the stack's older task definition. A newly bootstrapped service with
DesiredCount=0 must be scaled up after its migrations and first runtime deployment.

## Dev sample

`python3 deploy/seed-dev.py` publishes `event_interest` from
`examples/event-interest.json`, using a short-lived bootstrap token held in memory.
It refuses production and conflicting published definitions. The corresponding
CMS seed lives in `payload-cms/scripts/seed-forms-test.ts`. The website resolves the
CMS page at `/forms-test` and fetches its schema from the public Forms API at runtime.

## Runtime appvar injection

Forms invokes the shared `master_deploy.sh` directly with
`-j /config/forms-api-v6/appvar,/config/common/global-appvar`. It injects SSM ARN
references into the runtime task's `secrets` list; service-specific names take
precedence over matching globals. ECS resolves the values at task startup.
There is no Forms-specific appvar mapping script or extra Python/YAML dependency.

New releases pick up parameter additions and removals. After changing only an
existing parameter's value, force a new ECS deployment to refresh running tasks.

For Kafka delivery, create `BUSAPI_URL=https://api.topcoder-dev.com/v6` under the
Forms dev appvar path. The Forms `AUTH0_CLIENT_ID` / `AUTH0_CLIENT_SECRET` combine
with shared `AUTH0_URL`, `AUTH0_AUDIENCE`, and optional `AUTH0_PROXY_SERVER_URL` /
`TOKEN_CACHE_TIME`. Production needs its corresponding URL and authorized credentials.
Do not decrypt or copy shared values into the service path to perform injection.
