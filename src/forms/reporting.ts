import { BadRequestException } from '@nestjs/common';
import { FieldType } from '../generated/prisma/enums';
import { KEY_PATTERN } from './dto';
import type { StoredField } from './validation';

/**
 * Produces the stable PostgreSQL view identifier used by publication and reporting.
 * @param key Named form key. @param version Positive version number.
 * @returns Safely quoted qualified view name shorter than PostgreSQL's identifier limit.
 * @throws BadRequestException for unsafe keys or invalid revision numbers.
 */
export function reportViewName(key: string, version: number): string {
  if (
    !KEY_PATTERN.test(key) ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > 1000000
  )
    throw new BadRequestException('Invalid form key or version.');
  return `"forms"."${key}_v${version}"`;
}

/**
 * Builds one typed column per field, including text[] columns for relational multi-selects.
 * @param key Safe named form. @param version Revision number. @param versionId Stored UUID. @param fields Stored immutable fields.
 * @returns CREATE VIEW SQL for execution inside the publication transaction.
 * @throws Error for invalid database IDs/field identifiers; BadRequestException for invalid form identifiers.
 */
export function buildReportView(
  key: string,
  version: number,
  versionId: string,
  fields: StoredField[],
): string {
  const view = reportViewName(key, version);
  const columns = fields.map((field) => {
    if (!KEY_PATTERN.test(field.key))
      throw new Error('Invalid reporting field identifier.');
    let value: string;
    switch (field.type) {
      case FieldType.TEXT:
      case FieldType.TEXTAREA:
      case FieldType.EMAIL:
        value = 'a."textValue"';
        break;
      case FieldType.INTEGER:
        value = 'a."integerValue"';
        break;
      case FieldType.DECIMAL:
        value = 'a."decimalValue"';
        break;
      case FieldType.BOOLEAN:
        value = 'a."booleanValue"';
        break;
      case FieldType.DATE:
        value = 'a."dateValue"';
        break;
      case FieldType.SINGLE_SELECT:
        value =
          '(SELECT o.key FROM "forms"."FieldOption" o WHERE o.id = a."optionId")';
        break;
      case FieldType.MULTI_SELECT:
        value =
          'ARRAY(SELECT o.key::text FROM "forms"."AnswerSelection" c JOIN "forms"."FieldOption" o ON o.id = c."optionId" WHERE c."answerId" = a.id ORDER BY o.position)';
        break;
    }
    return `(SELECT ${value} FROM "forms"."Answer" a WHERE a."submissionId" = s.id AND a."fieldId" = ${uuidLiteral(field.id)}) AS "${field.key}"`;
  });
  return `CREATE VIEW ${view} AS SELECT s.id AS submission_id, s."createdAt" AS submitted_at, s."memberId" AS member_id, s."sourcePage" AS source_page, ${version}::integer AS form_version, ${columns.join(', ')} FROM "forms"."Submission" s WHERE s."versionId" = ${uuidLiteral(versionId)}`;
}

/**
 * Quotes a UUID read from PostgreSQL for DDL, where query parameters are unavailable.
 * @param value Stored UUID. @returns UUID SQL literal. @throws Error for malformed IDs.
 */
function uuidLiteral(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new Error('Invalid database UUID.');
  return `'${value}'::uuid`;
}

/**
 * Escapes a report value for RFC 4180 CSV and neutralizes spreadsheet formula prefixes.
 * @param value Scalar or multi-select report cell.
 * @returns Quoted CSV cell, with arrays represented as transport-only JSON text.
 * @throws No errors for supported report values.
 */
export function csvCell(value: unknown): string {
  let text =
    value == null
      ? ''
      : Array.isArray(value)
        ? JSON.stringify(value)
        : String(value);
  // Control characters are deliberately matched to prevent hidden formula prefixes.
  // eslint-disable-next-line no-control-regex
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))
    text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
