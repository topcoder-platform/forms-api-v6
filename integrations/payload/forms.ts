import type { Block, CollectionConfig, PayloadRequest } from 'payload' with {
  'resolution-mode': 'import',
};
import { fieldTypes, type FormDefinition } from '../contracts';

/** Persisted Payload editorial document; submissions are held exclusively by forms-api. */
export interface ManagedForm extends FormDefinition {
  id?: string | number;
  formKey: string;
  version: number;
  apiStatus: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  updatedAt?: string;
}
export interface FormsIntegrationOptions {
  apiBaseUrl: string;
  getAccessToken: () => Promise<string>;
  canManage: (req: PayloadRequest) => boolean | Promise<boolean>;
  syncComponentPath?: string;
}

/**
 * Synchronizes one saved Payload definition through retryable, version-pinned forms API calls.
 * @param form Saved editorial document. @param options Trusted server URL and M2M token provider.
 * @returns API revision metadata once the requested lifecycle state is reached.
 * @throws Error for unsafe URLs, failed HTTP requests, timeouts, or conflicting definitions.
 */
export async function syncForm(
  form: ManagedForm,
  options: Pick<FormsIntegrationOptions, 'apiBaseUrl' | 'getAccessToken'>,
): Promise<unknown> {
  const base = new URL(options.apiBaseUrl);
  if (
    base.protocol !== 'https:' &&
    !(
      base.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
    )
  )
    throw new Error('Forms API must use HTTPS outside local development.');
  if (base.username || base.password || base.search || base.hash)
    throw new Error(
      'Forms API URL must not contain credentials, a query, or a fragment.',
    );
  const token = await options.getAccessToken();
  const root = options.apiBaseUrl.replace(/\/$/, '');
  const path = `/forms/${encodeURIComponent(form.formKey)}/versions/${form.version}`;
  const definition: FormDefinition = {
    title: form.title,
    description: form.description ?? undefined,
    successMessage: form.successMessage,
    access: form.access,
    fields: form.fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required ?? false,
      ...(field.helpText ? { helpText: field.helpText } : {}),
      ...(field.maxLength != null ? { maxLength: field.maxLength } : {}),
      ...(field.minValue != null && field.minValue !== ''
        ? { minValue: field.minValue }
        : {}),
      ...(field.maxValue != null && field.maxValue !== ''
        ? { maxValue: field.maxValue }
        : {}),
      ...(field.type === 'SINGLE_SELECT' || field.type === 'MULTI_SELECT'
        ? {
            options: (field.options ?? []).map((option) => ({
              key: option.key,
              label: option.label,
            })),
          }
        : {}),
    })),
  };

  /**
   * Sends one bounded authenticated request without forwarding CMS metadata or following redirects.
   * @param method HTTP verb. @param resource Relative API route. @param body Optional definition data.
   * @returns Parsed API response. @throws Error on non-2xx responses or fetch/JSON failure.
   */
  async function call(
    method: string,
    resource: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetch(`${root}${resource}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    if (!response.ok) {
      const result: unknown = await response.json().catch(() => null);
      const message =
        result && typeof result === 'object' && 'message' in result
          ? result.message
          : 'Forms API request failed.';
      throw new Error(
        `Forms API ${response.status}: ${Array.isArray(message) ? message.join('; ') : String(message)}`,
      );
    }
    return response.json();
  }

  await call('POST', '/forms', { key: form.formKey });
  const draft = await call('PUT', path, definition);
  if (form.apiStatus === 'PUBLISHED') return call('POST', `${path}/publish`);
  if (form.apiStatus === 'RETIRED') return call('POST', `${path}/retire`);
  if (
    draft &&
    typeof draft === 'object' &&
    'status' in draft &&
    draft.status !== 'DRAFT'
  )
    throw new Error(
      'This API version is already published or retired. Use the next version number for a new draft.',
    );
  return draft;
}

/**
 * Builds a typed Payload collection for defining forms and explicitly synchronizing saved revisions.
 * @param options Server-only API/token configuration and the host CMS authorization callback.
 * @returns CollectionConfig to register in payload.config.ts; custom POST /:id/sync uses the same access policy.
 * @throws No errors at construction; sync endpoint returns 403/409/502 on authorization, concurrent edits, or upstream failures.
 */
export function createFormsCollection(
  options: FormsIntegrationOptions,
): CollectionConfig {
  return {
    slug: 'form-definitions',
    admin: {
      useAsTitle: 'title',
      group: 'Website forms',
      description:
        'Save a definition, then sync the saved form to apply it. Increment version before changing a synchronized definition.',
      ...(options.syncComponentPath
        ? {
            components: {
              edit: { beforeDocumentControls: [options.syncComponentPath] },
            },
          }
        : {}),
    },
    hooks: {
      beforeChange: [
        async ({ data, originalDoc }) => {
          if (
            originalDoc &&
            data.formKey !== undefined &&
            data.formKey !== originalDoc.formKey
          ) {
            const { APIError } = await import('payload');
            throw new APIError(
              'A form key is permanent. Create a new form document to use a different key.',
              400,
            );
          }
          return data;
        },
      ],
    },
    access: {
      create: ({ req }) => options.canManage(req),
      read: ({ req }) => options.canManage(req),
      update: ({ req }) => options.canManage(req),
      delete: () => false,
    },
    fields: [
      {
        name: 'formKey',
        type: 'text',
        required: true,
        unique: true,
        admin: {
          description:
            'Permanent lowercase snake_case form name, at most 40 characters.',
        },
      },
      {
        name: 'version',
        type: 'number',
        min: 1,
        max: 1000000,
        required: true,
        defaultValue: 1,
      },
      { name: 'title', type: 'text', required: true, maxLength: 200 },
      { name: 'description', type: 'textarea', maxLength: 2000 },
      {
        name: 'successMessage',
        type: 'textarea',
        required: true,
        maxLength: 1000,
        defaultValue: 'Thank you. Your submission was received.',
      },
      {
        name: 'access',
        type: 'select',
        options: ['ANONYMOUS', 'MEMBER'],
        required: true,
        defaultValue: 'ANONYMOUS',
      },
      {
        name: 'apiStatus',
        type: 'select',
        options: ['DRAFT', 'PUBLISHED', 'RETIRED'],
        required: true,
        defaultValue: 'DRAFT',
        admin: {
          description:
            'Requested API state. Saving in Payload does not change the live API until synchronization succeeds.',
        },
      },
      {
        name: 'fields',
        type: 'array',
        required: true,
        minRows: 1,
        maxRows: 50,
        fields: [
          { name: 'key', type: 'text', required: true, maxLength: 40 },
          { name: 'label', type: 'text', required: true, maxLength: 200 },
          { name: 'helpText', type: 'textarea', maxLength: 1000 },
          {
            name: 'type',
            type: 'select',
            options: [...fieldTypes],
            required: true,
          },
          { name: 'required', type: 'checkbox', defaultValue: false },
          { name: 'maxLength', type: 'number', min: 1, max: 10000 },
          {
            name: 'minValue',
            type: 'text',
            admin: { description: 'Exact decimal text, numeric fields only.' },
          },
          { name: 'maxValue', type: 'text' },
          {
            name: 'options',
            type: 'array',
            maxRows: 100,
            fields: [
              { name: 'key', type: 'text', required: true, maxLength: 40 },
              { name: 'label', type: 'text', required: true, maxLength: 200 },
            ],
          },
        ],
      },
      {
        name: 'lastSyncedAt',
        type: 'date',
        access: { create: () => false, update: () => false },
        admin: { readOnly: true },
      },
      {
        name: 'lastSyncedVersion',
        type: 'number',
        access: { create: () => false, update: () => false },
        admin: { readOnly: true },
      },
    ],
    endpoints: [
      {
        path: '/:id/sync',
        method: 'post',
        handler: async (req) => {
          if (!(await options.canManage(req)))
            return Response.json(
              { message: 'Not authorized to manage forms.' },
              { status: 403 },
            );
          const id = req.routeParams?.id;
          if (typeof id !== 'string' && typeof id !== 'number')
            return Response.json(
              { message: 'Missing form ID.' },
              { status: 400 },
            );
          const doc = (await req.payload.findByID({
            collection: 'form-definitions',
            id,
            depth: 0,
            overrideAccess: false,
            req,
          })) as unknown as ManagedForm;
          try {
            const result = await syncForm(doc, options);
            const updated = await req.payload.update({
              collection: 'form-definitions',
              where: {
                and: [
                  { id: { equals: id } },
                  { updatedAt: { equals: doc.updatedAt } },
                ],
              },
              data: {
                lastSyncedAt: new Date().toISOString(),
                lastSyncedVersion: doc.version,
              },
              overrideAccess: true,
              req,
            });
            if (updated.docs.length !== 1)
              return Response.json(
                {
                  message:
                    'The API received the saved revision, but this Payload document changed during synchronization. Review the latest document and synchronize again.',
                },
                { status: 409 },
              );
            return Response.json(result);
          } catch (error) {
            return Response.json(
              {
                message:
                  error instanceof Error
                    ? error.message
                    : 'Form synchronization failed. Retry the saved revision.',
              },
              { status: 502 },
            );
          }
        },
      },
    ],
  };
}

/** A composable Payload page block containing a stable form reference and no duplicated field schema. */
export const FormBlock: Block = {
  slug: 'topcoder-form',
  interfaceName: 'TopcoderFormBlock',
  labels: { singular: 'Topcoder form', plural: 'Topcoder forms' },
  fields: [
    {
      name: 'formKey',
      type: 'text',
      required: true,
      maxLength: 40,
      admin: {
        description:
          'Key from Form definitions. The website fetches the active API schema at runtime.',
      },
    },
  ],
};
