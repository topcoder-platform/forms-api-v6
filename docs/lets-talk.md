# /lets-talk rollout

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
`source__c=/lets-talk`; the website maps URL `utm_source`, `utm_medium`, and
`utm_campaign` parameters to the matching `utm_*__c` answers, leaving absent
parameters empty. These are validated answers, not trusted identity. The website
sends the shared `tcjwt` session as a bearer token when available; the API derives
`member_id` from verified claims, while anonymous submissions retain a null identity.
`sourcePage` is the current pathname. The site submits
`kafka: true` so each accepted attempt publishes `form.submitted` through the
existing Bus API integration. Consumers must deduplicate by `submissionId`.

## Rollout after review

1. Deploy this API revision and the existing `SubmissionEvent` migration. Configure
   outbound `BUSAPI_URL`, `KAFKA_ERROR_TOPIC` and the M2M settings for the provider
   `USE_KEYCLOAK` selects (`KEYCLOAK_TOKEN_URL`, `KEYCLOAK_AUDIENCE`, `KEYCLOAK_CLIENT_ID`,
   `KEYCLOAK_CLIENT_SECRET` when `true`; otherwise `AUTH0_URL`, `AUTH0_AUDIENCE`,
   `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`) as described in operations.md.
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
   defaults to the development API. Set `FORMS_API_BASE_URL=https://api.topcoder.com/v6`
   for production. It creates no submissions and fails on differing
   immutable content. Re-running an identical version is safe; subsequent schema
   changes require a reviewed next version.
4. Deploy the companion `topcoder-website` develop change and the `platform-ui` dev
   change. No CMS content mutation is required: the website selects the known form
   component on the matching dev or production `/lets-talk` route. Other
   routes continue using their existing forms.
5. Verify the public schema, then submit an explicitly marked development test with
   Kafka configured. Confirm the receipt, event, table row, date filtering, and CSV.
   A Bus API outage returns 503 after saving; retry unchanged inputs to finish delivery.

The React integration accepts `kafka` (false by default) and `hiddenAnswers`
(empty by default). Hidden answers are merged into the API payload and omitted
from visible controls. They must match stored field types and validation rules.
The website maintains its analytics adapter around the same rendering contract.

## Production release order

1. Release the API migration `20261013010000_lets_talk_processor_key`. It corrects
   the initial flow's `lets-talk` key to `lets_talk` without changing its enabled
   state or settings, and reroutes retained submissions missing a delivery receipt.
   The existing migration remains unchanged. Existing successful receipts are preserved.
2. Publish the reviewed version using the command above with
   `FORMS_API_BASE_URL=https://api.topcoder.com/v6` and a production admin token.
3. Deploy forms-processor-v6 through its master pipeline. Set SecureStrings
   `/config/forms-processor-v6/appvar/LETS_TALK_RECIPIENTS` (comma-separated emails)
   and `/config/forms-processor-v6/appvar/LETS_TALK_SENDGRID_TEMPLATE_ID` (dynamic
   template ID). Redeploy to load changed parameters, then enable the database
   flow after reviewing any queued submissions. See the processor rollout guide.
4. Release the website production selection. Confirm the public schema and exact
   `https://www.topcoder.com` CORS origin before switching the live page.
5. Submit an identified test with `kafka: true`, correlate its submission ID through
   `form.submitted` and `external.action.email`, and verify the received email.
   Processor `deliveredAt` means Bus API acceptance; verify provider/inbox delivery
   separately. No historical HubSpot data is imported.
