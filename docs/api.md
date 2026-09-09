# API contract

Base prefix: `/v6`. OpenAPI UI: `/v6/forms/api-docs`; specification: `/v6/forms/api-docs-json`. The local `/v6/docs` and `/v6/docs-json` aliases remain available. Readiness is `/v6/forms/health/ready` (also `/v6/health/ready` locally).

## Endpoints

| Method and path                                     | Access   | Behavior                                                                                                                               |
| --------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                       | Public   | Liveness.                                                                                                                              |
| `GET /health/ready`                                 | Public   | Database readiness; 503 when unavailable.                                                                                              |
| `POST /forms`                                       | Manage   | `{ "key": "event_interest" }`; idempotent registration, 201.                                                                           |
| `GET /forms?after=event_interest`                   | Manage   | Up to 100 named forms and version summaries; `nextCursor` is a form key.                                                               |
| `PUT /forms/:key/versions/:version`                 | Manage   | Full definition; next sequential revision, starting at 1. Identical retries succeed; changed content at the same revision returns 409. |
| `GET /forms/:key/versions/:version`                 | Manage   | Draft/published/retired definition with lifecycle metadata.                                                                            |
| `POST /forms/:key/versions/:version/publish`        | Manage   | Publish and create a SQL view; automatically retire the prior publication. Idempotent while this version remains published.            |
| `POST /forms/:key/versions/:version/retire`         | Manage   | Stop new submissions; retain reports. Idempotent for retired versions.                                                                 |
| `GET /forms/:key`                                   | Public   | Current published schema, `Cache-Control: no-store`; 404 when no version is published.                                                 |
| `POST /forms/:key/submissions`                      | Per-form | Pinned version and answers, required `Idempotency-Key` UUID v4; returns 201 receipt.                                                   |
| `GET /forms/:key/versions/:version/submissions`     | Report   | Named-column JSON page; `limit` 1–1000 (default 100), optional receipt ID cursor `after`.                                              |
| `GET /forms/:key/versions/:version/submissions.csv` | Report   | CSV page with the same pagination; `X-Next-Cursor` when more rows remain.                                                              |

Keys are lowercase snake_case, begin with a letter, and contain at most 40 characters. Revision numbers range from 1 through 1,000,000. The definition accepts 1–50 fields and up to 100 options per choice field. The request body limit is 512 KiB.

## Authentication

Authorization is deny-by-default. Public routes may omit a token; supplying an invalid token still returns 401. Configure either HTTPS JWKS/RS256 or the legacy HS256 shared-secret mode. The two verification paths have separate algorithm allowlists. Signature, issuer, audience, expiry, issued-at presence, and subject are required.

Roles are matched case-insensitively. Roles and userId are read from direct claims or the exact `AUTH_CLAIM_NAMESPACE` prefix, default `https://topcoder.com/`. Subject is retained for editor audit; member forms require an actual `userId` claim. A missing userId is not silently replaced with an Auth0 subject.

| Caller    | Manage access                                 | Report access                            | Submit access                                           |
| --------- | --------------------------------------------- | ---------------------------------------- | ------------------------------------------------------- |
| Human     | `Administrator` or `Forms Administrator` role | `Administrator` or `Forms Reporter` role | Anonymous forms; member forms require a verified userId |
| Machine   | `manage:forms` scope                          | `read:forms-submissions` scope           | Rejected                                                |
| Anonymous | Rejected                                      | Rejected                                 | Only `ANONYMOUS` forms                                  |

Machine tokens are recognized by `gty=client-credentials`, `isMachine=true`, a `sub` ending in `@clients`, or scopes with no roles, matching the neighboring APIs' role/scope distinction. Machines cannot gain human permissions through role claims; human tokens do not gain management/report access solely through scopes.

## Definition and submission

See [the complete definition example](../examples/event-interest.json). Each field provides `key`, `label`, `type`, optional `required`, optional `helpText`, type-specific bounds, and options for choices. Definitions reject unrelated validation rules, unknown properties, duplicate keys, duplicate choices, and reserved reporting names.

```http
POST /v6/forms/event_interest/submissions
Content-Type: application/json
Idempotency-Key: 6b3d585c-f134-4e06-a6d5-6ea42fc1c7ce

{
  "version": 1,
  "answers": {
    "email": "member@example.com",
    "full_name": "Example Member",
    "interests": ["design", "development"],
    "receive_updates": false
  },
  "sourcePage": "/events",
  "website": ""
}
```

`sourcePage` is an optional relative path, not a full URL; query strings/fragments are rejected. It is caller-supplied context, not trusted attribution. `website` is an optional honeypot that must remain empty. The included renderer uses an internal `_website` control name so a legitimate form field named `website` does not collide with it.

```json
{
  "id": "c1ab5d27-722a-431f-a811-46737109de1f",
  "version": 1,
  "submittedAt": "2026-09-09T01:00:00.000Z"
}
```

Receipts contain no answers or member details. All answers must belong to the pinned stored revision; client-supplied field definitions and extra answer keys are rejected. Server validation does not coerce number or boolean strings. Decimal values are exact strings; multi-select answers are arrays of option keys. Every answer and its selections commit atomically with the envelope.

## Retry and error handling

Generate one cryptographically random UUID for a logical submission attempt. Reuse it with the same revision, answers, member identity, and source page after a timeout or lost response. The service canonicalizes decimals and multi-select order before hashing. An identical retry returns the original receipt; changed content with that key returns 409. This key remains reserved while the submission is retained.

A previously accepted attempt can be retried after a version is retired. A new attempt targeting a draft/retired version returns 409. A member-form retry still requires the member token. The API does not replay a submission under a different member identity.

Field-validation errors have a field-keyed map:

```json
{
  "message": "Form validation failed.",
  "errors": { "email": "Expected a valid email address." }
}
```

Envelope/DTO errors use Nest's standard `message` array. Clients should handle both shapes, preserve entered values after failures, and display success only after receiving a successful receipt. The included React renderer does this and keeps the retry key in memory for unchanged attempts.

| Status  | Meaning                                                             |
| ------- | ------------------------------------------------------------------- |
| 400     | Invalid definition, answers, envelope, UUID, or pagination cursor.  |
| 401     | Missing/invalid token, or member identity required.                 |
| 403     | Insufficient role/scope, or a machine tried to submit.              |
| 404     | Unknown form/version or no publicly available publication.          |
| 409     | Version conflict, closed/stale form, or changed idempotent attempt. |
| 413     | Body exceeds 512 KiB.                                               |
| 429     | Request rate exceeded.                                              |
| 500/503 | Service/database failure; preserve input and retry appropriately.   |

Reports are ordered by creation timestamp and UUID. Pagination does not create a database snapshot; use SQL/reporting jobs when an exact export snapshot is required. CSV is quoted and formula-prefixed text is neutralized for spreadsheets; arrays are JSON-encoded only in the exported CSV cell. SQL data remains fully relational.
