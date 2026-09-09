# Deployment status — 2026-09-09

## Completed and verified in dev

- CloudFormation stack `forms-api-v6-dev` owns service `forms-api-v6` in cluster
  `topcoder-infrastructure` (AWS account `811668436784`, `us-east-1`).
- The current service uses task definition `forms-api-v6:4`; ECS is healthy and
  stable. `release-dev.json` records the exact runtime/migration image digests.
- Gateway routes `/v6/forms` and `/v6/forms/{proxy+}` use the existing private
  services ALB and CloudFront origin authorizer. The protected root returns 401
  without a token; published forms, readiness, and docs return 200.
- Swagger UI is live at `https://api.topcoder-dev.com/v6/forms/api-docs` and its
  specification at `/v6/forms/api-docs-json`; browser rendering was verified.
- `event_interest` version 1 matches `examples/event-interest.json`.
- Dev now uses database `topcoder-services`, schema `forms`, and the supplied
  `forms` login. Both encrypted database URL parameters are at version 2.
- The original form, revision, four fields, three options, and one submission
  (four answers and one selection) were copied with all values/IDs preserved.
  `schema-migration-dev.json` records the comparison and rollback references.
- Reporting is now `forms.event_interest_v1`. A fresh browser submission was
  verified in this schema and removed; the original submission remains intact.
- The old `forms` database is retained for recovery with runtime writes revoked.
  Its migration files are archived unchanged in `prisma/legacy-migrations`.
  Current releases use the new schema baseline and explicitly qualify all models,
  raw SQL, enums, functions, and views with `forms`.
- The migration rehearsal copied 45 forms, 49 revisions/views, and 33 submissions
  in a disposable database with full contents matching. Schema integration tests
  also passed with no CREATE privileges in `public` or at database level, leaving
  an existing `public."Form"` sentinel untouched. Both GitHub checks for code commit
  `580fdef` passed.
- `https://www.topcoder-dev.com/forms-test` is live. A real browser submitted all
  four fields successfully (HTTP 201); the database row matched all answers,
  including boolean false and all three interests. Synthetic data was deleted.
- Payload UAT records: form component `36766`, page content `36768`, page `36767`.
  The page uses the normal `page` → `pageContentBasic` → embedded form structure.
- Payload changes are on `develop`, commit `bbe575e`. Its CircleCI job 178 passed
  and deployed `payload-cms:56`. Two existing dependency findings blocking the
  release were fixed with sharp 0.35.4 and js-yaml 4.3.2.
- Website renderer commit `df2dd13` deployed successfully in CircleCI job 413.
  Follow-up commit `a54e6ca` documents and rebuilds the final CMS content graph;
  build job 416 and deploy job 418 both passed. The live deployment marker matches
  `a54e6ca7eaed06340a6eaf6d0fc4b5ae170284af-418`. A fresh browser submission
  against this release passed, its database answers matched, and it was deleted.
- API code is in private `topcoder-platform/forms-api-v6`, with `origin` pointing
  there and the original `jmgasper/forms-api-v6` remote retained as `personal`.
  Both `develop` and `master` contain the CircleCI flow. `develop` is the default.
- Official CircleCI CLI configuration validation passed. API lint/build, 25 unit
  tests, 12 integration tests, and GitHub Actions passed. Website lint/build and
  all 144 Vitest / 20 API tests passed; CMS lint/build and all 414 tests passed.

## Still required for the full goal

1. Connect `topcoder-platform/forms-api-v6` to CircleCI with `org-global`, then
   observe a successful deploy from `develop`. No CircleCI API token is available
   to this session (`circleci auth me` reports `auth.token_missing`). The official
   CLI is installed temporarily at `/tmp/forms-circleci-cli/circleci`.
2. Verify/provision the production stack and settings described in `README.md`,
   then verify the `master` deployment flow with valid production access.
   `/home/jmgasper/Downloads/prod_env.txt` was rejected by AWS and the default AWS
   login session is expired. Dev credentials are valid. Both access requests were
   sent to the user; there has been no response at this checkpoint. Access was
   checked again after the final website deployment: CircleCI still reports
   `auth.token_missing`, and production STS still returns `InvalidClientTokenId`.

The overall goal is **not complete**. Do not infer CircleCI activation or production
readiness from the checked-in workflow or successful dev workstation deployment.

## Useful verification handles

- Website job 418: https://circleci.com/gh/topcoder-platform/topcoder-website/418
- CMS job 178: https://circleci.com/gh/topcoder-platform/payload-cms/178
- GitHub commit statuses can be read without CircleCI credentials via `gh api`.
- `/tmp/forms-browser.cjs` exercises the live website, captures desktop/mobile
  screenshots, and writes `/tmp/forms-browser-result.json`. Its synthetic receipt
  must be verified/cleaned in the dedicated forms database after a rerun.
- `/tmp/forms-run-cms.py` loads the dev CMS environment from SSM into a child
  process without writing secrets to disk. Run `nvm use` in the CMS worktree first.
- Related clean worktrees are `../.worktrees/payload-cms-forms-test` and
  `../.worktrees/topcoder-website-forms-test`. The original CMS/website worktrees
  and their pre-existing edits were preserved.
