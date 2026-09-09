import { BadRequestException } from '@nestjs/common';
import { isEmail } from 'class-validator';
import {
  Prisma,
  type FormField,
  type FieldOption,
} from '../generated/prisma/client';
import { FieldType } from '../generated/prisma/enums';
import { DECIMAL_PATTERN, RESERVED_KEYS, type DefinitionDto } from './dto';

export type StoredField = FormField & { options: FieldOption[] };
export type AnswerValue = string | number | boolean | string[];
export interface ValidatedAnswer {
  field: StoredField;
  value: AnswerValue;
}

/**
 * Validates relationships between fields, rules, and choices before a revision is saved.
 * @param definition DTO already checked by Nest's validation pipe.
 * @returns Nothing when the definition is internally consistent.
 * @throws BadRequestException for duplicate/reserved keys or rules incompatible with the field type.
 */
export function validateDefinition(definition: DefinitionDto): void {
  const keys = new Set<string>();
  for (const field of definition.fields) {
    if (keys.has(field.key) || RESERVED_KEYS.has(field.key))
      fail(
        field.key,
        'Field keys must be unique and cannot use reporting metadata names.',
      );
    keys.add(field.key);
    const choices =
      field.type === FieldType.SINGLE_SELECT ||
      field.type === FieldType.MULTI_SELECT;
    if (choices !== Boolean(field.options?.length))
      fail(field.key, 'Only choice fields must provide options.');
    if (
      new Set(field.options?.map((option) => option.key)).size !==
      (field.options?.length ?? 0)
    )
      fail(field.key, 'Option keys must be unique.');
    const text = (
      [FieldType.TEXT, FieldType.TEXTAREA, FieldType.EMAIL] as FieldType[]
    ).includes(field.type);
    if (field.maxLength != null && !text)
      fail(field.key, 'maxLength is only valid for text fields.');
    const numeric =
      field.type === FieldType.INTEGER || field.type === FieldType.DECIMAL;
    if ((field.minValue != null || field.maxValue != null) && !numeric)
      fail(field.key, 'Numeric bounds are only valid for numeric fields.');
    if (
      field.minValue != null &&
      field.maxValue != null &&
      new Prisma.Decimal(field.minValue).gt(field.maxValue)
    )
      fail(field.key, 'minValue must not exceed maxValue.');
    for (const bound of [field.minValue, field.maxValue]) {
      if (
        field.type === FieldType.INTEGER &&
        bound != null &&
        (!new Prisma.Decimal(bound).isInteger() ||
          new Prisma.Decimal(bound).lt(-2147483648) ||
          new Prisma.Decimal(bound).gt(2147483647))
      )
        fail(field.key, 'Integer bounds must fit a 32-bit integer.');
    }
    if (!field.label.trim() || field.options?.some((o) => !o.label.trim()))
      fail(field.key, 'Labels must not be blank.');
  }
  if (!definition.title.trim() || !definition.successMessage.trim())
    fail('definition', 'Title and success message must not be blank.');
}

/**
 * Validates and canonicalizes incoming answers against the server-owned immutable fields.
 * @param fields Stored field definitions. @param input User-supplied answer object.
 * @returns Ordered present answers; optional omissions stay absent, false and zero are preserved.
 * @throws BadRequestException for unknown fields, missing required values, or invalid types/bounds/choices.
 */
export function validateAnswers(
  fields: StoredField[],
  input: Record<string, unknown>,
): ValidatedAnswer[] {
  const keys = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(input))
    if (!keys.has(key)) fail(key, 'Unknown field.');
  const answers: ValidatedAnswer[] = [];
  for (const field of fields) {
    const value = Object.hasOwn(input, field.key)
      ? input[field.key]
      : undefined;
    const empty =
      value === undefined ||
      value === null ||
      value === '' ||
      (typeof value === 'string' && value.trim() === '') ||
      (Array.isArray(value) && value.length === 0);
    if (empty) {
      if (field.required) fail(field.key, 'This field is required.');
      continue;
    }
    let canonical: AnswerValue;
    switch (field.type) {
      case FieldType.TEXT:
      case FieldType.TEXTAREA:
      case FieldType.EMAIL:
        if (
          typeof value !== 'string' ||
          value.includes('\0') ||
          [...value].length > (field.maxLength ?? 10000)
        )
          fail(field.key, 'Expected text within the configured length limit.');
        if (field.type === FieldType.EMAIL && !isEmail(value))
          fail(field.key, 'Expected a valid email address.');
        canonical = value;
        break;
      case FieldType.INTEGER:
        if (
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < -2147483648 ||
          value > 2147483647
        )
          fail(field.key, 'Expected a 32-bit integer JSON number.');
        validateBounds(field, new Prisma.Decimal(value));
        canonical = value;
        break;
      case FieldType.DECIMAL:
        if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value))
          fail(
            field.key,
            'Expected decimal text with at most 14 integer and 6 fractional digits.',
          );
        validateBounds(field, new Prisma.Decimal(value));
        canonical = new Prisma.Decimal(value).toFixed();
        break;
      case FieldType.BOOLEAN:
        if (typeof value !== 'boolean')
          fail(field.key, 'Expected a JSON boolean.');
        canonical = value;
        break;
      case FieldType.DATE: {
        if (
          typeof value !== 'string' ||
          !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)
        )
          fail(field.key, 'Expected a calendar date YYYY-MM-DD.');
        const date = new Date(`${value}T00:00:00.000Z`);
        if (
          !Number.isFinite(date.getTime()) ||
          date.toISOString().slice(0, 10) !== value
        )
          fail(field.key, 'Invalid calendar date.');
        canonical = value;
        break;
      }
      case FieldType.SINGLE_SELECT:
        if (
          typeof value !== 'string' ||
          !field.options.some((o) => o.key === value)
        )
          fail(field.key, 'Expected one configured option key.');
        canonical = value;
        break;
      case FieldType.MULTI_SELECT:
        if (
          !Array.isArray(value) ||
          value.length > field.options.length ||
          value.some(
            (v) =>
              typeof v !== 'string' || !field.options.some((o) => o.key === v),
          ) ||
          new Set(value).size !== value.length
        )
          fail(field.key, 'Expected unique configured option keys.');
        canonical = (value as string[]).slice().sort();
        break;
    }
    answers.push({ field, value: canonical });
  }
  return answers;
}

/**
 * Checks numeric bounds while retaining PostgreSQL decimal precision.
 * @param field Stored numeric field. @param value Exact number.
 * @returns Nothing. @throws BadRequestException when a bound is exceeded.
 */
function validateBounds(field: StoredField, value: Prisma.Decimal): void {
  if (
    (field.minValue !== null && value.lt(field.minValue)) ||
    (field.maxValue !== null && value.gt(field.maxValue))
  )
    fail(field.key, 'Value is outside the configured bounds.');
}

/**
 * Creates the public field-validation error consumed by form renderers.
 * @param field Stable field key. @param message User-readable error.
 * @returns Never. @throws BadRequestException with a field-keyed error map.
 */
function fail(field: string, message: string): never {
  throw new BadRequestException({
    message: 'Form validation failed.',
    errors: { [field]: message },
  });
}
