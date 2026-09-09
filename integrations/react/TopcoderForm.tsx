'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { isPublicForm, type FormField, type PublicForm } from '../contracts';

export interface TopcoderFormProps {
  formKey: string;
  apiBaseUrl: string;
  getAccessToken?: () => Promise<string | undefined>;
}

/**
 * Renders an API-owned schema referenced by a Payload block, preserving inputs and retry keys on failure.
 * Cancels pending work when the block reference changes so an old receipt cannot complete a new form.
 * @param props Stable form key, public API base ending in /v6, and optional signed-in member token provider.
 * @returns Accessible loading, form, error, or receipt UI; submission failures are displayed without throwing.
 * @throws No errors during ordinary rendering; fetch/token failures are caught and displayed.
 */
export function TopcoderForm({
  formKey,
  apiBaseUrl,
  getAccessToken,
}: TopcoderFormProps): ReactNode {
  const [schema, setSchema] = useState<PublicForm | null>(null);
  const [state, setState] = useState<
    'loading' | 'ready' | 'pending' | 'success' | 'load-error'
  >('loading');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const busy = useRef(false);
  const activeSubmission = useRef<AbortController | null>(null);
  const instance = useId();
  const base = apiBaseUrl.replace(/\/$/, '');

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    setSchema(null);
    setError('');
    setFieldErrors({});
    attempt.current = null;
    busy.current = false;
    fetch(`${base}/forms/${encodeURIComponent(formKey)}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Form unavailable.');
        return response.json() as Promise<unknown>;
      })
      .then((value) => {
        if (controller.signal.aborted) return;
        if (!isPublicForm(value) || value.key !== formKey)
          throw new Error('Invalid form schema.');
        setSchema(value);
        setState('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setState('load-error');
      });
    return () => {
      controller.abort();
      activeSubmission.current?.abort();
      activeSubmission.current = null;
    };
  }, [base, formKey]);

  /**
   * Submits native control values against the displayed revision and reuses the attempt UUID on retries.
   * @param event Native form event. @returns Completion after updating UI state.
   * @throws No errors; network, identity, validation, and stale-version failures become visible messages.
   */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!schema || busy.current) return;
    const data = new FormData(event.currentTarget);
    const body = JSON.stringify({
      version: schema.version,
      answers: collectAnswers(schema.fields, data),
      sourcePage: window.location.pathname,
      website: data.get('_website') ?? '',
    });
    if (attempt.current?.body !== body)
      attempt.current = { body, key: crypto.randomUUID() };
    const attemptKey = attempt.current.key;
    const controller = new AbortController();
    activeSubmission.current = controller;
    busy.current = true;
    setState('pending');
    setError('');
    setFieldErrors({});
    try {
      const token = await getAccessToken?.();
      if (controller.signal.aborted) return;
      if (schema.access === 'MEMBER' && !token) {
        setError('Please sign in to submit this form.');
        setState('ready');
        return;
      }
      const response = await fetch(
        `${base}/forms/${encodeURIComponent(formKey)}/submissions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': attemptKey,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body,
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(20000),
          ]),
        },
      );
      const result: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (!response.ok) {
        setFieldErrors(readFieldErrors(result));
        setError(
          response.status === 409
            ? 'This form changed or this attempt conflicts with a previous submission. Reload the page before submitting again.'
            : response.status === 401
              ? 'Please sign in again to submit this form.'
              : response.status === 429
                ? 'Too many requests. Please wait a minute and try again.'
                : 'Your submission could not be saved. Check the fields and try again.',
        );
        setState('ready');
        return;
      }
      if (
        !result ||
        typeof result !== 'object' ||
        !('id' in result) ||
        typeof result.id !== 'string'
      )
        throw new Error('Missing submission receipt.');
      setState('success');
      attempt.current = null;
    } catch {
      if (controller.signal.aborted) return;
      setError(
        'We could not confirm your submission. Your answers are still here; please try again.',
      );
      setState('ready');
    } finally {
      if (activeSubmission.current === controller) {
        busy.current = false;
        activeSubmission.current = null;
      }
    }
  }

  if (state === 'loading') return <p role="status">Loading form…</p>;
  if (state === 'load-error' || !schema)
    return <p role="alert">This form is currently unavailable.</p>;
  if (state === 'success') return <p role="status">{schema.successMessage}</p>;
  return (
    <form onSubmit={submit} aria-label={schema.title}>
      <h2>{schema.title}</h2>
      {schema.description && <p>{schema.description}</p>}
      {schema.access === 'MEMBER' && (
        <p>Please sign in to your Topcoder account before submitting.</p>
      )}
      {error && <p role="alert">{error}</p>}
      <fieldset
        disabled={state === 'pending'}
        style={{ border: 0, margin: 0, padding: 0 }}
      >
        <legend
          className="sr-only"
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            overflow: 'hidden',
          }}
        >
          {schema.title}
        </legend>
        {schema.fields.map((field) => (
          <FieldControl
            key={field.key}
            field={field}
            id={`${instance}-${field.key}`}
            error={fieldErrors[field.key]}
          />
        ))}
        <div
          aria-hidden="true"
          style={{ position: 'absolute', left: '-10000px' }}
        >
          <label>
            Leave this empty
            <input name="_website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>
        <button type="submit">
          {state === 'pending' ? 'Submitting…' : 'Submit'}
        </button>
      </fieldset>
    </form>
  );
}

/**
 * Converts browser form values into the API's strict scalar/choice types without losing decimal precision.
 * @param fields Displayed server schema. @param data Native FormData.
 * @returns Named answers with optional blank values omitted; no exceptions for native controls.
 */
export function collectAnswers(
  fields: FormField[],
  data: FormData,
): Record<string, unknown> {
  const answers: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const field of fields) {
    if (field.type === 'MULTI_SELECT') {
      const values = data
        .getAll(field.key)
        .filter((v): v is string => typeof v === 'string');
      if (values.length) answers[field.key] = values;
      continue;
    }
    const value = data.get(field.key);
    if (typeof value !== 'string' || value === '') continue;
    answers[field.key] =
      field.type === 'INTEGER'
        ? Number(value)
        : field.type === 'BOOLEAN'
          ? value === 'true'
          : value;
  }
  return answers;
}

/**
 * Renders one allowlisted native control with labels, required semantics, help, and field errors.
 * @param props Field schema, unique DOM ID, and optional validation message.
 * @returns Accessible control markup. @throws No errors for validated public schema fields.
 */
function FieldControl({
  field,
  id,
  error,
}: {
  field: FormField;
  id: string;
  error?: string;
}): ReactNode {
  const common = {
    id,
    name: field.key,
    required: field.required,
    'aria-invalid': Boolean(error),
    'aria-describedby':
      [field.helpText ? `${id}-help` : '', error ? `${id}-error` : '']
        .filter(Boolean)
        .join(' ') || undefined,
  };
  let control: ReactNode;
  if (field.type === 'TEXTAREA')
    control = (
      <textarea {...common} maxLength={field.maxLength ?? 10000} rows={5} />
    );
  else if (field.type === 'BOOLEAN')
    control = (
      <select {...common} defaultValue="">
        <option value="">Choose…</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  else if (field.type === 'SINGLE_SELECT' || field.type === 'MULTI_SELECT')
    control = (
      <select
        {...common}
        multiple={field.type === 'MULTI_SELECT'}
        defaultValue={field.type === 'MULTI_SELECT' ? [] : ''}
      >
        {field.type === 'SINGLE_SELECT' && <option value="">Choose…</option>}
        {field.options?.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
    );
  else
    control = (
      <input
        {...common}
        type={
          field.type === 'EMAIL'
            ? 'email'
            : field.type === 'DATE'
              ? 'date'
              : field.type === 'INTEGER'
                ? 'number'
                : 'text'
        }
        inputMode={field.type === 'DECIMAL' ? 'decimal' : undefined}
        step={field.type === 'INTEGER' ? 1 : undefined}
        min={
          field.type === 'INTEGER' ? (field.minValue ?? -2147483648) : undefined
        }
        max={
          field.type === 'INTEGER' ? (field.maxValue ?? 2147483647) : undefined
        }
        maxLength={field.maxLength ?? 10000}
      />
    );
  return (
    <div style={{ marginBottom: '1rem' }}>
      <label htmlFor={id}>
        {field.label}
        {field.required ? ' (required)' : ''}
      </label>
      {control}
      {field.helpText && <p id={`${id}-help`}>{field.helpText}</p>}
      {error && <p id={`${id}-error`}>{error}</p>}
    </div>
  );
}

/**
 * Extracts only string validation messages from an API error response.
 * @param value Unknown response body. @returns Safe field-keyed messages; never throws.
 */
function readFieldErrors(value: unknown): Record<string, string> {
  if (
    !value ||
    typeof value !== 'object' ||
    !('errors' in value) ||
    !value.errors ||
    typeof value.errors !== 'object'
  )
    return {};
  return Object.fromEntries(
    Object.entries(value.errors).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}
