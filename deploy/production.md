# Production handoff — 2026-10-06

Production infrastructure is provisioned in AWS account `409275337247`, region
`us-east-1`. CloudFormation stack `forms-api-v6-production` owns service
`forms-api-v6` on cluster `topcoder-infrastructure`. The service is intentionally
at **zero replicas** until the first configured release. No production database
migration or application startup has been performed.

## Before merging develop into master

Update these four **SecureString** parameters under
`/config/forms-api-v6/appvar` in the production account:

| Parameter | Required value |
| --- | --- |
| `DATABASE_URL` | Production Forms schema-owner connection URL. The placeholder targets the shared production `topcoder-services` database with user `forms`, `schema=forms`, and `sslmode=verify-full`. Replace `REPLACE_ME` with the URL-encoded password and confirm the database/user. |
| `MIGRATION_DATABASE_URL` | Connection URL for the owner of the same `forms` schema. The same Forms login can be used for both URLs. Replace its placeholder independently. |
| `AUTH0_CLIENT_ID` | Production M2M client authorized to publish through Bus API. |
| `AUTH0_CLIENT_SECRET` | Matching production M2M client secret. |

The `forms` login/schema must already be provisioned in that database. The login
must own `forms`; runtime publication creates reporting views there. CircleCI runs
`prisma migrate deploy` to create the application objects before deploying the
runtime. This setup does not create a database login/schema or copy development
records into production. Existing Forms data would require a separate migration
plan; do not point the baseline at an unrelated existing installation.

Review these populated SecureStrings under the same appvar path:

| Parameter | Initial value |
| --- | --- |
| `BUSAPI_URL` | `https://api.topcoder.com/v6` |
| `VALID_ISSUERS` | JSON list: `https://api.topcoder.com`, `https://topcoder.auth0.com/`, `https://auth.topcoder.com/` |
| `CORS_ORIGINS` | `https://www.topcoder.com,https://reports.topcoder.com,https://platform-ui.topcoder.com` |
| `TRUST_PROXY_CIDRS` | `10.25.0.0/16` |
| `AUTH_CLAIM_NAMESPACE` | `https://topcoder.com/` |
| `THROTTLE_LIMIT` | `30` |
| `KAFKA_ERROR_TOPIC` | `common.error.reporting` |
| `NODE_ENV`, `PORT`, `AWS_REGION` | `production`, `3000`, `us-east-1` |

The existing production SecureStrings in `/config/common/global-appvar` provide
`AUTH_SECRET`, `AUTH0_URL`, `AUTH0_AUDIENCE`, `AUTH0_PROXY_SERVER_URL`, and
`TOKEN_CACHE_TIME`. They were preserved and are referenced by the shared deployment
suite. No shared secrets were copied from dev or replaced with placeholders.
Service appvars override matching globals, including `VALID_ISSUERS`.

All 13 `/config/forms-api-v6/deployvar` settings are populated as SecureStrings,
including the generated task role name and the correctly escaped readiness
command. They require no placeholder replacement. The complete list of 27 new
parameters is in [production-parameters-manifest.json](production-parameters-manifest.json).

## First release

After updating the configuration, merge the prepared `develop` branch into
`master`. CircleCI uses `org-global`, requests production credentials, builds and
pushes the migration image, and runs migrations in the service's private network.
Only a successful migration proceeds to the shared `master_deploy.sh` runtime
release. `activate.py` then starts a zero-count service at one replica and waits
for the requested image's tasks to be healthy. Later releases retain the existing
nonzero replica count. Rollback, wrong-image, and readiness failures fail the job.

The expected public endpoints are:

- `https://api.topcoder.com/v6/forms/health/ready`
- `https://api.topcoder.com/v6/forms/api-docs`

Until the first release, these routes return 503 because there are no runtime
targets. Parameter value changes require new tasks to take effect.

## Provisioned infrastructure

- Task definition `forms-api-v6:1`, Fargate, 512 CPU units / 1024 MiB, port 3000.
- ECR repository `forms-api-v6`, immutable release tags and image scanning.
- VPC `vpc-7cc06b19`; private subnets `subnet-0d91bddbea456aa6b` and
  `subnet-7f657057` in the ALB's enabled availability zones; public IPs disabled.
- Task security group `sg-0bf5e59924ba4a023`: inbound 3000 only from the services
  ALB; outbound HTTPS and PostgreSQL to the database security group.
- PostgreSQL ingress from this task group to `sg-930253f6` on port 5432.
- Target group `forms-api-v6-production`, readiness health check, ALB HTTPS rule
  priority 680 for `/v6/forms` and `/v6/forms/*`.
- API Gateway `kthgpat40e`, both Forms routes, existing TLS/VPC integration
  `6tcvbtt` and CloudFront origin authorizer `ptbwwm`.
- Initial task/migration log group `/aws/ecs/forms-api-v6-production`; shared
  deployment suite runtime logs use `/aws/ecs/topcoder-infrastructure`.
- Stack termination protection enabled. Existing shared execution and CI roles
  already grant the required access; no shared IAM policy changes were needed.

[production.parameters.json](production.parameters.json) records the initial
CloudFormation parameters. It contains `ImageTag=bootstrap` and `DesiredCount=0`;
**do not apply it unchanged to an active service**. Preserve the live task
reference and replica count when performing later infrastructure updates, because
shared-script application deployments do not update CloudFormation's task output.

## Verification and limits

Both production subnets passed temporary ECS preflight tasks using the packaged
runtime image and shared execution role. Checks covered ECR pulls, encrypted SSM
injection, runtime configuration parsing, CloudWatch logging, HTTPS access to the
JWKS/Auth0/API endpoints, and PostgreSQL connectivity with RDS certificate
verification. These checks did not authenticate to PostgreSQL, request an M2M
token, publish a Bus event, or run application migrations. Auth0 proxy/API probes
only established connectivity; their unauthenticated responses do not establish
that service credentials work.

CloudFormation reached `CREATE_COMPLETE`; all 27 new parameters are SecureStrings.
The CI role's ECR, SSM, CloudFormation read, ECS, and role-passing permissions were
checked with IAM policy simulation. The shared deployvar export script correctly
round-tripped the task role and escaped health command. Local lint, build, runtime
Docker build, and six deployment regression tests passed. A production CircleCI
run remains intentionally deferred until the real configuration is supplied and
`master` is merged.

[production-readiness.json](production-readiness.json) records the AWS identifiers
and both preflight task results. The temporary preflight definition was deregistered;
the stopped tasks/logs and immutable preflight image remain as verification evidence.
