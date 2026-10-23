# Keycloak M2M migration branch

This code is isolated on `keycloak_m2M`. Do not deploy this branch until the
workload and its callers are ready. Existing DEV services continue using Auth0.
The core dependency is pinned to a reviewed Keycloak prerelease commit, including
transitive wrapper uses through the pnpm override. No npm latest dependency is used.

The core is pinned to `tc-core-library-js` commit `e844764` (4.0.0-keycloak.1) in
`package.json` and the `pnpm-workspace.yaml` override, and `pnpm-lock.yaml` resolves
that single version, including the copy `tc-bus-api-wrapper` uses.

## Provider switch: `USE_KEYCLOAK`

`USE_KEYCLOAK=true` makes this service get its Bus API M2M tokens from Keycloak, using
`KEYCLOAK_TOKEN_URL`, `KEYCLOAK_AUDIENCE`, `KEYCLOAK_CLIENT_ID` and
`KEYCLOAK_CLIENT_SECRET` (optional `KEYCLOAK_SCOPE` narrows the client's defaults).
`KEYCLOAK_ISSUER` is also required. Unset or `false` restores the Auth0 behaviour from
before the migration: when `BUSAPI_URL` is set, `readConfig` requires `AUTH0_URL`,
`AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET` and passes the optional
`AUTH0_PROXY_SERVER_URL`; `TOKEN_CACHE_TIME` and `KAFKA_ERROR_TOPIC` apply in both modes.
Only the active provider's settings are required.

`tc-core-library-js` makes the decision (`auth.useKeycloak`), so the service and the
core always agree. Any value other than `true`/`false` fails at startup. In DEV the
flag is `/config/common/global-appvar/USE_KEYCLOAK`.

Incoming machine tokens: with `true`, Keycloak tokens are accepted, plus Auth0 tokens
while `LEGACY_M2M_ISSUERS`/`LEGACY_M2M_AUDIENCE` are set. With `false`, Auth0 tokens
are accepted through `LEGACY_M2M_*`, plus Keycloak tokens while `KEYCLOAK_ISSUER` and
`KEYCLOAK_AUDIENCE` are set, so callers that have not switched yet keep working.

**Rollback:** set `USE_KEYCLOAK=false` and force a new deployment so tasks re-read SSM.
No code or dependency change is needed. Keep the Auth0 settings above in SSM until
Keycloak has been accepted.

The DEV issuer is `https://keycloak.topcoder-dev.com/realms/topcoder-m2m-dev`,
audience `https://api.topcoder-dev.com`, and managed endpoint
`https://keycloak.topcoder-dev.com/m2m/token`. Wait for the managed endpoint's
recorded deployment acceptance before enabling this configuration.

Member sessions remain Auth0. Keep `VALID_ISSUERS` and `AUTH_SECRET` where legacy
member HMAC tokens are supported. Set `AUTH_USER_AUDIENCES` to a JSON array, or
explicitly retain existing user-token audience behavior with
`ALLOW_LEGACY_USER_AUDIENCE=true`. Never apply that exception to M2M tokens.
`LEGACY_M2M_ISSUERS` and `LEGACY_M2M_AUDIENCE` let Auth0 machine tokens pass the same
normalizer (see the provider switch above).

`tc-core-library-js` owns signature, issuer, audience, lifetime, and machine/user
classification. Service adapters must use its verified `kind`, `isMachine`, and
`scopes` rather than decode/reclassify claims. Scope guards delegate exact matching
to the library with explicit all/any policy. Existing business roles and documented
scope aliases remain endpoint policy; adding OAuth scopes to a user token never
grants machine access. No permissive fallback or synthetic token path is available.

Before rollout run this project's `nvm use`, `pnpm lint`, `pnpm build`, and targeted
authentication tests. Validate real authorized/unauthorized routes with both a
Keycloak service token and a member token, including wrong audiences and insufficient
scopes. Switch only after every downstream receiver accepts the issuer. The core never
retries a failed Keycloak request against Auth0; rolling back is the explicit
`USE_KEYCLOAK=false` change above. `test/event-bus.spec.ts` checks both modes.

Validation: Lint, build, typecheck, all 69 unit tests, and all 24 integration tests pass. Integration tests used a dedicated disposable PostgreSQL 17 container, removed afterward. Real member HMAC/RSA and Keycloak RSA tests preserve the role/scope split. Compiled guard accepted a real DEV service token.
The `USE_KEYCLOAK` change adds 8 unit tests (77 in total, all passing); it does not touch the integration-test configuration path.
