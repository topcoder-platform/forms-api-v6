# Payload CMS and website integration

The service contains portable, compiled TypeScript integrations for Payload 3 and React 19. Payload handles editorial form definitions; forms-api is authoritative for published definitions and submissions. Content pages store only a stable form reference. Browser code receives no CMS or management credentials.

## Register the editorial collection

Copy `integrations/` into the host CMS's `src/integrations/`, preserving relative paths. The CMS needs the `contracts.ts` and `payload/` files; the website needs `contracts.ts` and `react/`. Both host projects already supply their respective Payload/React dependencies. The API runtime image does not include these development dependencies.

Register the collection in `payload.config.ts`. The example uses the existing Topcoder `isCmsAdmin` policy, which checks the authenticated `admins` collection and `cms-admin` role:

```ts
import { isCmsAdmin } from '@/access/cms-admin';
import { createFormsCollection } from '@/integrations/payload/forms';

const Forms = createFormsCollection({
  apiBaseUrl: process.env.FORMS_API_BASE_URL!, // e.g. https://forms.example.com/v6
  canManage: (req) => isCmsAdmin(req.user),
  // Supply the CMS server's cached/rotating client-credentials token provider.
  // Token scope: manage:forms. Do not expose this token through NEXT_PUBLIC_*.
  getAccessToken: getFormsManagementToken,
  // The current Topcoder CMS importMap.baseDir is src/.
  syncComponentPath: './integrations/payload/SyncFormControl#SyncFormControl',
});

// Append Forms to the existing collections array in buildConfig({ ... }).
```

`getFormsManagementToken` is a host integration dependency: use the host's server-side OAuth token provider for the configured issuer/audience. The adapter accepts an asynchronous provider so cached tokens can refresh naturally. `FORMS_API_BASE_URL` is server configuration, never an editor-provided URL. External URLs must use HTTPS; localhost HTTP is supported for development. Requests reject redirects and have a 15-second timeout.

The collection uses native text, checkbox, select, number, and array fields, so editorial schema data is structured in Payload's PostgreSQL adapter too. It does not use a JSON field. Its API sync projection removes Payload-generated row IDs and metadata before calling forms-api's strict DTO validation.

After registration, in the **Payload project folder**, select its own Node version and generate the required artifacts:

```sh
nvm use
pnpm generate:types
pnpm generate:importmap
pnpm migrate:create
pnpm lint
pnpm build
```

Review/apply the generated Payload migration through that service's normal release process. The existing CMS uses `push: false`, so adding a collection in configuration alone does not create its database tables.

## Editor workflow

1. Create a form definition with a permanent `formKey`, version 1, title, access policy, and fields.
2. Save the document in Payload. Unsynchronized drafts can be edited locally.
3. Choose `PUBLISHED` as the requested API state, save, and click **Sync saved form**. The button sends `POST /api/form-definitions/{id}/sync` using the editor's Payload session.
4. The server checks the same CMS management policy, registers the named form, saves the immutable API revision, and publishes it. The button reports the actual returned API status.
5. For later changes, increment the version, save, and synchronize. The API rejects changed definitions at a previously synchronized version.
6. To close a form, keep its existing definition/version, set `RETIRED`, save, and synchronize. Deleting the CMS document is disabled, preventing accidental abandonment of an active API form.

The form key cannot be changed after the first CMS save. Create another form for another identity. `DRAFT` saves a definition without publishing; it cannot revert a previously published version to draft. A new draft revision leaves the current published revision active until the new one is published.

The sync control operates on the **last saved** document. Save editor changes first. The control can be omitted by leaving `syncComponentPath` unset; the protected sync endpoint still works for CMS automation.

## Embed in a native Payload content page

The included block stores only `formKey`. Add it to the host page's block field, or to its Lexical BlocksFeature when using native rich text:

```ts
import { FormBlock } from '@/integrations/payload/forms'

// In a native content page collection:
{
  name: 'layout',
  type: 'blocks',
  blocks: [/* existing blocks */, FormBlock],
}
```

For Lexical, add the same block through `BlocksFeature({ blocks: [FormBlock] })` alongside the page editor's existing features; register a frontend converter for the `topcoder-form` block. Payload's [blocks documentation](https://payloadcms.com/docs/fields/blocks) describes the native storage shape. Do not overwrite the host's existing layout or editor feature list.

A saved block has this transport shape:

```json
{ "blockType": "topcoder-form", "formKey": "event_interest" }
```

Render that block on the website:

```tsx
import { TopcoderForm } from '@/integrations/react/TopcoderForm';

// In the block renderer:
<TopcoderForm
  formKey={block.formKey}
  apiBaseUrl={process.env.NEXT_PUBLIC_FORMS_API_BASE_URL!}
/>;
```

For member forms, wrap it in a client component that supplies `getAccessToken` from the website's existing Topcoder login/session integration. It must return the visitor's member JWT. Do not pass a function from a Next.js server component across the server/client boundary; the wrapper defines the function on the client. Anonymous forms need no token provider.

The renderer fetches the current schema at runtime, avoiding stale CMS/static-build copies of field definitions. It submits the displayed version, typed values, and page pathname directly to forms-api. Add the website's exact origin to API `CORS_ORIGINS` and its API origin to the website's CSP `connect-src`. A same-origin reverse proxy can be used instead with an API base such as `/forms-api/v6`.

The supplied renderer has native labels, help/error associations, explicit boolean choices, multiselect controls, loading/pending/success/error states, and UUID replay handling. It preserves values after failures and keeps decimal values as strings. Style its semantic HTML using the website's existing form styles.

## Current Topcoder repositories

The inspected `payload-cms` repository primarily serves migrated Contentful-shaped content through a compatibility layer. `topcoder-website/src/components/cms/Renderer.tsx` currently routes HubSpot form models to `CmsForm` and handles join-group forms separately.

For those migrated pages, introduce a distinct content model such as `componentTopcoderForm` with a required `formKey` text field, permit it in the page's content-component references, and register it in the compatibility model/renderer allowlists. Its renderer should read the key and render `TopcoderForm`. This provides the same contract as the native block without changing existing HubSpot or group-action behavior.

The service includes the adapters and their tests. Host collection registration, the appropriate page-model migration, and website renderer registration are documented integration steps; existing CMS/website worktrees were not modified or deployed. They can be released independently once the service endpoint and environment-specific credentials are configured.

## Failure and recovery semantics

There is no distributed transaction across Payload and forms-api. Synchronization is explicit and uses retryable API operations:

- Registering a key repeatedly returns the same form.
- Saving identical content at the same version succeeds; conflicting content returns 409.
- Repeating publication of an active version or retirement of a retired version succeeds.
- Each API operation commits independently; a network failure can occur after the API accepted the revision. Retry the same saved document/version to reconcile it.
- Sync records `lastSyncedAt`/`lastSyncedVersion` only if Payload's `updatedAt` still matches the saved document that was sent. A concurrent local edit returns 409 and asks the editor to review/resync.
- If API publication succeeds but updating CMS sync metadata fails, the API form is already live. The next sync reuses the accepted revision and repairs metadata. A failed metadata write is not an automatic rollback of a live form.

This avoids silently publishing on every draft/autosave hook. The hook lifecycle itself is documented by [Payload](https://payloadcms.com/docs/hooks/collections); the adapter uses a custom authenticated sync endpoint and a before-change guard for immutable form keys.
