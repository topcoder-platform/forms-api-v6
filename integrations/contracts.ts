/** Public contract shared by the portable Payload adapter and React website renderer. */
export const fieldTypes = [
  'TEXT',
  'TEXTAREA',
  'EMAIL',
  'INTEGER',
  'DECIMAL',
  'BOOLEAN',
  'DATE',
  'SINGLE_SELECT',
  'MULTI_SELECT',
] as const;
export type FieldType = (typeof fieldTypes)[number];
export interface FormField {
  key: string;
  label: string;
  helpText?: string | null;
  type: FieldType;
  required?: boolean;
  maxLength?: number | null;
  minValue?: string | null;
  maxValue?: string | null;
  options?: { key: string; label: string }[];
}
export interface FormDefinition {
  title: string;
  description?: string | null;
  successMessage: string;
  access: 'ANONYMOUS' | 'MEMBER';
  fields: FormField[];
}
export interface PublicForm extends FormDefinition {
  key: string;
  version: number;
}

/**
 * Validates the public schema envelope before a renderer creates controls.
 * @param value Untrusted API response.
 * @returns True for a structurally valid public schema; throws no errors.
 */
export function isPublicForm(value: unknown): value is PublicForm {
  if (!value || typeof value !== 'object') return false;
  const form = value as Partial<PublicForm>;
  return (
    typeof form.key === 'string' &&
    /^[a-z][a-z0-9_]{0,39}$/.test(form.key) &&
    Number.isInteger(form.version) &&
    (form.version ?? 0) > 0 &&
    typeof form.title === 'string' &&
    typeof form.successMessage === 'string' &&
    ['ANONYMOUS', 'MEMBER'].includes(form.access ?? '') &&
    Array.isArray(form.fields) &&
    form.fields.length > 0 &&
    form.fields.length <= 50 &&
    form.fields.every(
      (f) =>
        f &&
        typeof f === 'object' &&
        typeof f.key === 'string' &&
        typeof f.label === 'string' &&
        fieldTypes.includes(f.type) &&
        (!f.options ||
          (Array.isArray(f.options) &&
            f.options.every(
              (o) => typeof o?.key === 'string' && typeof o.label === 'string',
            ))),
    )
  );
}
