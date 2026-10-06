# Development /lets-talk migration

`examples/lets-talk.json` mirrors the form schema returned by
`https://www.topcoder.com/__api/forms/XpPgFzW8lmX8frlStzzg0` on 2026-09-28.
It preserves the six visible fields, their order and required flags, interest
labels, hidden attribution fields, and the HubSpot success message.
The stable Forms API key is `lets_talk` and the title is “Let’s talk” for reporting discovery. No historical HubSpot submissions are imported.

Option values are normalized to API-safe keys:

| HubSpot value | Forms API key |
| --- | --- |
| `Crowdsourcing` | `crowdsourcing` |
| `App Design & Development` | `app_design_development` |
| `Freelancers` | `freelancers` |
| `Landing Page` (hidden lead source) | `landing_page` |

The website supplies the existing hidden campaign defaults, including
`source__c=/lets-talk`; empty UTM fields remain empty. These are validated answers,
not trusted identity. `sourcePage` is the current pathname. The site submits
`kafka: true` so each accepted attempt publishes `form.submitted` through the
existing Bus API integration. Consumers must deduplicate by `submissionId`.

## Rollout after review

1. Deploy this API revision and the existing `SubmissionEvent` migration. Configure
   outbound `BUSAPI_URL`, `AUTH0_URL`, `AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID`,
   `AUTH0_CLIENT_SECRET`, and `KAFKA_ERROR_TOPIC` as described in operations.md.
2. Ensure `CORS_ORIGINS` / CloudFormation `CorsOrigins` includes the exact website
   and reports origins (`https://www.topcoder-dev.com`,
   `https://reports.topcoder-dev.com`, `https://platform-ui.topcoder-dev.com` for the
   combined portal). Existing stacks retain parameter values: update the parameter
   explicitly; changing the template default alone does not update a deployed stack.
3. Publish the reviewed definition from this repository root, supplying an existing
   administrator bearer token or M2M token with `manage:forms` through the environment:

   ```sh
   nvm use
   pnpm exec tsx scripts/publish-lets-talk.ts
   ```

   `FORMS_ADMIN_TOKEN` must be set without putting it in source control. The script
   hardcodes the development API, creates no submissions, and fails on differing
   immutable content. Re-running an identical version is safe; subsequent schema
   changes require a reviewed next version.
4. Deploy the companion `topcoder-website` develop change and the `platform-ui` dev
   change. No CMS content mutation is required: the website selects the known form
   component only on the development `/lets-talk` route. Production and other
   routes continue using their existing forms.
5. Verify the public schema, then submit an explicitly marked development test with
   Kafka configured. Confirm the receipt, event, table row, date filtering, and CSV.
   A Bus API outage returns 503 after saving; retry unchanged inputs to finish delivery.

The React integration accepts `kafka` (false by default) and `hiddenAnswers`
(empty by default). Hidden answers are merged into the API payload and omitted
from visible controls. They must match stored field types and validation rules.
The website maintains its analytics adapter around the same rendering contract.
