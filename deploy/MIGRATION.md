# OIDC deployment migration

This change replaces the Auth0 credential broker and SSM-to-shell deployment path with [tc-deploy-scripts v2.0.9](https://github.com/topcoder-platform/tc-deploy-scripts/releases/tag/v2.0.9), fetched by tag and verified against commit `dc06de730f068a230efa9d5f4d4d9c80782d3bfb`. Build and deployment run in separate jobs. The deployer cannot read Parameter Store, Secrets Manager or decrypt KMS data, including through another assumed role. ECS continues resolving the existing runtime secret references using the execution role.

## Production target

The read-only inventory on 2026-11-03 verified account `409275337247`, cluster `topcoder-infrastructure`, service `forms-api-v6`, family `forms-api-v6`, and container `forms-api-v6`. `prod.json` preserves the observed task/execution roles and names the proposed service-specific deployment role. [prod-baseline.json](https://github.com/topcoder-platform/v6-services-iac/blob/main/services/forms-api-v6/deploy/prod-baseline.json) records references only; it contains no parameter values. Do not recreate the service or replace its complete task definition from this baseline.

## Infrastructure prerequisites, applied separately by an administrator

1. In each account, register the CircleCI OIDC issuer `https://oidc.circleci.com/org/947bef5e-1669-415d-b83c-4fc85155b7df` with client ID `947bef5e-1669-415d-b83c-4fc85155b7df`. The current production account has only the legacy Auth0 provider. Do not remove that provider until all its consumers have migrated.
2. Review and install [iam/prod-role.cloudformation.json](https://github.com/topcoder-platform/v6-services-iac/blob/main/services/forms-api-v6/deploy/iam/prod-role.cloudformation.json) with an administrator/IaC identity. It creates the proposed deployment role and applies the same least-privilege policy as a permissions boundary. The trust binds this CircleCI project, repository, checkout branch and configuration branch. It does not grant infrastructure creation to CircleCI. The role and matching boundary include `inspector2:ListFindings` and `inspector2:ListCoverage` restricted to the deployment region; these scan-metadata APIs require `Resource: "*"`. Secret-access denies remain explicit.
3. Configure ECR repository `forms-api-v6` with unconditional `IMMUTABLE` tags and supported scanning. Preserve existing enhanced scanning where enabled. Existing tags are not retagged. The release fails for MEDIUM/HIGH/CRITICAL/UNDEFINED findings, failed scans, or a mismatched digest.
4. In the infrastructure that owns the task definition, add the reviewed container check from `prod-healthcheck.json`, keeping all roles, runtime secret references, resources, mounts and sidecars. Verify the health endpoint against the running container in dev first. Preserve circuit-breaker rollback; the Forms-specific first-activation rule is described below. Remove any `RESET_DB` secret binding and plaintext secret environment entries before adoption. Keep the execution role's runtime read permissions scoped to the references that service needs.
5. Create restricted `forms-api-v6-dev-deploy` and `forms-api-v6-prod-deploy` CircleCI contexts without Auth0/static AWS credentials. Restrict production to the reviewed `master` checkout and configuration ref, authorized operators, and approval job. Remove legacy credentials from project settings too: removing `org-global` alone does not remove project-level variables. Confirm `CIRCLE_OIDC_TOKEN_V3` is issued. Disable secret access for forks and SSH debugging in deployment jobs.

## Development acceptance before merge/release

Read-only inventory on 2026-11-04 verified `dev.json` against the actual development service, task/execution roles and image repositories. This PR targets `develop`. Matching IAM templates and detailed baselines remain private. **Keep this PR in draft until the service-specific prerequisites below are complete.** No AWS or CircleCI resources were provisioned by this refresh.

- Install the service deployment role and matching permissions boundary.
- Create the restricted empty CircleCI deployment context.
- Review and install the dev container health-check proposal; preserve all other task configuration.
- Verify one-shot migration secret/execution-role grants and migration-before-runtime promotion in dev.

Run the shared offline suite, validate the CircleCI config and IAM policies, and test a dev release plus an unhealthy-image rollback. Verify CloudTrail contains no SSM/Secrets Manager calls from the deployment principal. Remove its old broker grants only after migration. Check the runtime secret references and roles stayed unchanged. Production requires the manual approval job and a passing digest/scan/health verification.

The pinned executor is `cimg/aws@sha256:4cf3768db00ddf9bc439b8c84e8a60c11a14edf81c8baf76f74132144f8340d5`. Python/AWS CLI/Buildx/Git compatibility was tested with the shared offline suite. No package installation or service build runs in the deployment job. The Dockerfile retains the existing in-image quality gates. This PR does not deploy, change IAM, rotate credentials, or claim a successful live rollout.

## Forms migration and first activation

The adapter preserves the stable-stack/environment/bootstrap checks, runs the separate migration image as a private one-shot task, and requires exit code zero plus the exact scanned image digest before runtime promotion. Both images are built without credentials and scanned before either executes. The migration image runs as non-root. The only added permissions are the exact migration task family and read access to the existing Forms stack; the deployment role still cannot read parameter values. ECS resolves the migration database secret through the existing execution role.

Unlike the default CLI, this reviewed adapter retains Forms first activation: an existing zero-capacity service is started at one replica only after the infrastructure bootstrap and migration gates pass. Existing positive capacity is preserved. Runtime read-back, concurrency, digest/health and rollback checks must pass. Migration waiting is bounded to 15 minutes and runtime observation to 20 minutes, within the one-hour STS session; a timeout fails without pretending the rollout succeeded. Test both first activation and failed migration in dev.

## Infrastructure source

IAM templates and detailed AWS baselines are maintained in the private [v6-services-iac service directory](https://github.com/topcoder-platform/v6-services-iac/tree/main/services/forms-api-v6). Provision infrastructure separately with an administrator identity; application CI does not fetch that repository or install IAM. Required application manifests and health-check proposals remain here.

## Dev branch refresh

This PR targets `develop` and preserves its current application/dependency fixes. The shared suite is v2.0.9 (82 offline tests); service-specific adapters and their tests remain part of review. Keep this PR in draft until its documented infrastructure and integration prerequisites are met. Updating these files does not provision AWS or CircleCI resources.

Source checkout uses the public HTTPS repository and verifies the exact CircleCI commit, avoiding dependency on failing SSH checkout keys. No GitHub token is added to build or deployment contexts.
