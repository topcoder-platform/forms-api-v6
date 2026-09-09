import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { DbService } from '../db.service';
import { Prisma } from '../generated/prisma/client';
import { FieldType, FormStatus } from '../generated/prisma/enums';
import type { Actor } from '../auth';
import { DefinitionDto, KEY_PATTERN, PageDto, SubmissionDto } from './dto';
import { buildReportView, csvCell, reportViewName } from './reporting';
import {
  validateAnswers,
  validateDefinition,
  type ValidatedAnswer,
} from './validation';

const definitionInclude = {
  form: true,
  fields: {
    orderBy: { position: 'asc' },
    include: { options: { orderBy: { position: 'asc' } } },
  },
} satisfies Prisma.FormVersionInclude;
type Definition = Prisma.FormVersionGetPayload<{
  include: typeof definitionInclude;
}>;

/** Manages immutable form revisions, publication, typed submission writes, and private reports. */
@Injectable()
export class FormsService {
  /**
   * Creates the domain service used by the HTTP controller.
   * @param db Shared Prisma connection. @throws No errors.
   */
  constructor(private readonly db: DbService) {}

  /**
   * Idempotently registers a specifically named form.
   * @param key Validated form key. @returns Stable form identity. @throws Database errors on persistence failure.
   */
  async createForm(key: string) {
    return this.db.form.upsert({ where: { key }, create: { key }, update: {} });
  }

  /**
   * Lists named forms and their version status for CMS/admin discovery.
   * @param after Optional previous key. @returns Up to 100 forms and the next key cursor.
   * @throws BadRequestException for unsafe cursors; database errors on read failure.
   */
  async listForms(after?: string) {
    if (after && !KEY_PATTERN.test(after))
      throw new BadRequestException('Invalid form cursor.');
    const forms = await this.db.form.findMany({
      where: after ? { key: { gt: after } } : {},
      orderBy: { key: 'asc' },
      take: 101,
      include: {
        versions: {
          orderBy: { version: 'desc' },
          select: { version: true, title: true, status: true, access: true },
        },
      },
    });
    const data = forms.slice(0, 100);
    return { data, nextCursor: forms.length > 100 ? data.at(-1)!.key : null };
  }

  /**
   * Saves the next immutable draft or returns an identical retry of an existing revision.
   * @param key Existing form key. @param version Next sequential number. @param input Complete definition. @param actor Verified editor identity.
   * @returns Stored draft/publication metadata and public definition.
   * @throws BadRequestException for invalid definitions, NotFoundException for unknown forms, ConflictException for reused or nonsequential revisions.
   */
  async putVersion(
    key: string,
    version: number,
    input: DefinitionDto,
    actor: Actor,
  ) {
    reportViewName(key, version);
    validateDefinition(input);
    const normalized = {
      title: input.title,
      description: input.description ?? null,
      successMessage: input.successMessage,
      access: input.access,
      fields: input.fields.map((field, position) => ({
        key: field.key,
        label: field.label,
        helpText: field.helpText ?? null,
        type: field.type,
        required: field.required,
        position,
        maxLength: field.maxLength ?? null,
        minValue:
          field.minValue == null
            ? null
            : new Prisma.Decimal(field.minValue).toFixed(),
        maxValue:
          field.maxValue == null
            ? null
            : new Prisma.Decimal(field.maxValue).toFixed(),
        options: (field.options ?? []).map((o, optionPosition) => ({
          key: o.key,
          label: o.label,
          position: optionPosition,
        })),
      })),
    };
    const definitionHash = digest(normalized);
    return this.db.$transaction(async (tx) => {
      const formId = await this.lockForm(tx, key);
      const existing = await tx.formVersion.findUnique({
        where: { formId_version: { formId, version } },
        include: definitionInclude,
      });
      if (existing) {
        if (existing.definitionHash !== definitionHash)
          throw new ConflictException(
            'This version already contains a different definition. Use the next version number.',
          );
        return this.adminDefinition(existing);
      }
      const latest = await tx.formVersion.aggregate({
        where: { formId },
        _max: { version: true },
      });
      if (version !== (latest._max.version ?? 0) + 1)
        throw new ConflictException(
          'Use the next sequential version number, starting at 1.',
        );
      const { fields, ...metadata } = normalized;
      const created = await tx.formVersion.create({
        data: {
          ...metadata,
          formId,
          version,
          definitionHash,
          createdBy: actor.subject,
          fields: {
            create: fields.map(({ options, ...field }) => ({
              ...field,
              options: { create: options },
            })),
          },
        },
        include: definitionInclude,
      });
      return this.adminDefinition(created);
    });
  }

  /**
   * Fetches a revision for authenticated administration, including draft status.
   * @param key Form key. @param version Revision number. @returns Definition with lifecycle metadata.
   * @throws NotFoundException for unknown revisions; BadRequestException for invalid identifiers.
   */
  async getVersion(key: string, version: number) {
    return this.adminDefinition(await this.findVersion(this.db, key, version));
  }

  /**
   * Returns only the active public schema, excluding audit and database implementation fields.
   * @param key Form key. @returns Public definition consumed by embedded renderers.
   * @throws NotFoundException if the form has no active publication.
   */
  async getPublicForm(key: string) {
    const definition = await this.db.formVersion.findFirst({
      where: { form: { key }, status: FormStatus.PUBLISHED },
      include: definitionInclude,
    });
    if (!definition) throw new NotFoundException('Published form not found.');
    return publicDefinition(definition);
  }

  /**
   * Publishes a draft and its typed reporting view atomically, retiring the previous publication.
   * @param key Form key. @param version Draft number. @param actor Verified publisher.
   * @returns Published definition; identical publication retries return the same result.
   * @throws ConflictException for retired/obsolete drafts; NotFoundException for missing forms; database errors if view creation fails.
   */
  async publish(key: string, version: number, actor: Actor) {
    return this.db.$transaction(
      async (tx) => {
        const formId = await this.lockForm(tx, key);
        const definition = await this.findVersion(tx, key, version);
        if (definition.status === FormStatus.PUBLISHED)
          return this.adminDefinition(definition);
        if (definition.status === FormStatus.RETIRED)
          throw new ConflictException(
            'Retired versions cannot be republished. Create a new version.',
          );
        const newer = await tx.formVersion.findFirst({
          where: {
            formId,
            version: { gt: version },
            publishedAt: { not: null },
          },
        });
        if (newer)
          throw new ConflictException(
            'A newer version has already been published.',
          );
        await tx.formVersion.updateMany({
          where: { formId, status: FormStatus.PUBLISHED },
          data: {
            status: FormStatus.RETIRED,
            retiredAt: new Date(),
            retiredBy: actor.subject,
          },
        });
        // All DDL identifiers and literals are validated by buildReportView; no user SQL is accepted.
        await tx.$executeRawUnsafe(
          buildReportView(key, version, definition.id, definition.fields),
        );
        const published = await tx.formVersion.update({
          where: { id: definition.id },
          data: {
            status: FormStatus.PUBLISHED,
            publishedAt: new Date(),
            publishedBy: actor.subject,
          },
          include: definitionInclude,
        });
        return this.adminDefinition(published);
      },
      { timeout: 15000 },
    );
  }

  /**
   * Closes a published form while retaining its schema, submissions, and reporting view.
   * @param key Form key. @param version Published revision. @param actor Verified editor.
   * @returns Retired metadata, also for identical retries.
   * @throws ConflictException for drafts; NotFoundException for missing revisions.
   */
  async retire(key: string, version: number, actor: Actor) {
    return this.db.$transaction(async (tx) => {
      await this.lockForm(tx, key);
      const definition = await this.findVersion(tx, key, version);
      if (definition.status === FormStatus.DRAFT)
        throw new ConflictException('Only published versions can be retired.');
      if (definition.status === FormStatus.RETIRED)
        return this.adminDefinition(definition);
      const retired = await tx.formVersion.update({
        where: { id: definition.id },
        data: {
          status: FormStatus.RETIRED,
          retiredAt: new Date(),
          retiredBy: actor.subject,
        },
        include: definitionInclude,
      });
      return this.adminDefinition(retired);
    });
  }

  /**
   * Validates against the pinned version and saves the entire typed submission in one transaction.
   * @param key Form key. @param input Answer envelope. @param idempotencyKey Caller-generated UUID. @param actor Optional verified member.
   * @returns Receipt without answers or identity; exact retries return the original receipt even after retirement.
   * @throws BadRequestException for invalid answers; UnauthorizedException for missing member identity; ForbiddenException for machine submissions; ConflictException for stale versions or changed retry payloads.
   */
  async submit(
    key: string,
    input: SubmissionDto,
    idempotencyKey: string,
    actor?: Actor,
  ) {
    if (!isUUID(idempotencyKey, '4'))
      throw new BadRequestException(
        'Idempotency-Key must be a random UUID v4.',
      );
    if (actor?.machine)
      throw new ForbiddenException(
        'Machine tokens cannot submit visitor forms.',
      );
    return this.db.$transaction(
      async (tx) => {
        await this.lockForm(tx, key);
        const definition = await this.findVersion(tx, key, input.version);
        if (definition.access === 'MEMBER' && !actor?.memberId)
          throw new UnauthorizedException(
            'Sign in with a Topcoder member token to submit this form.',
          );
        const validated = validateAnswers(definition.fields, input.answers);
        const requestHash = digest({
          version: input.version,
          memberId: actor?.memberId ?? null,
          sourcePage: input.sourcePage ?? null,
          answers: validated.map(({ field, value }) => [field.key, value]),
        });
        const existing = await tx.submission.findUnique({
          where: {
            versionId_idempotencyKey: {
              versionId: definition.id,
              idempotencyKey,
            },
          },
        });
        if (existing) {
          if (existing.requestHash !== requestHash)
            throw new ConflictException(
              'Idempotency-Key was already used for a different submission.',
            );
          return {
            id: existing.id,
            version: input.version,
            submittedAt: existing.createdAt,
          };
        }
        if (definition.status !== FormStatus.PUBLISHED)
          throw new ConflictException(
            'This form version is no longer accepting submissions. Reload the form.',
          );
        const submission = await tx.submission.create({
          data: {
            versionId: definition.id,
            idempotencyKey,
            requestHash,
            memberId: actor?.memberId,
            sourcePage: input.sourcePage,
          },
        });
        for (const answer of validated)
          await this.writeAnswer(tx, submission.id, definition.id, answer);
        return {
          id: submission.id,
          version: input.version,
          submittedAt: submission.createdAt,
        };
      },
      { timeout: 15000 },
    );
  }

  /**
   * Reads a bounded submission page with stable named columns for private reporting.
   * @param key Form key. @param version Published or retired revision. @param page Page size and optional prior receipt ID.
   * @returns Column metadata, rows, and next cursor; numeric decimals are exact strings.
   * @throws BadRequestException for a cursor outside this version; ConflictException for drafts; NotFoundException for missing forms.
   */
  async report(key: string, version: number, page: PageDto) {
    const definition = await this.findVersion(this.db, key, version);
    if (definition.status === FormStatus.DRAFT)
      throw new ConflictException('Draft versions have no submission report.');
    if (
      page.after &&
      !(await this.db.submission.findFirst({
        where: { id: page.after, versionId: definition.id },
      }))
    )
      throw new BadRequestException(
        'Cursor does not belong to this form version.',
      );
    const submissions = await this.db.submission.findMany({
      where: { versionId: definition.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: page.limit + 1,
      ...(page.after ? { cursor: { id: page.after }, skip: 1 } : {}),
      include: {
        answers: {
          include: { option: true, selections: { include: { option: true } } },
        },
      },
    });
    const data = submissions.slice(0, page.limit).map((submission) => {
      const row: Record<string, unknown> = {
        submission_id: submission.id,
        submitted_at: submission.createdAt.toISOString(),
        member_id: submission.memberId,
        source_page: submission.sourcePage,
        form_version: version,
      };
      for (const field of definition.fields) {
        const answer = submission.answers.find((a) => a.fieldId === field.id);
        row[field.key] = !answer
          ? null
          : answer.type === FieldType.MULTI_SELECT
            ? answer.selections
                .sort((a, b) => a.option.position - b.option.position)
                .map((s) => s.option.key)
            : (answer.textValue ??
              answer.integerValue ??
              answer.decimalValue?.toFixed() ??
              answer.booleanValue ??
              answer.dateValue?.toISOString().slice(0, 10) ??
              answer.option?.key ??
              null);
      }
      return row;
    });
    return {
      form: key,
      version,
      view: reportViewName(key, version),
      columns: [
        'submission_id',
        'submitted_at',
        'member_id',
        'source_page',
        'form_version',
        ...definition.fields.map((f) => f.key),
      ],
      data,
      nextCursor:
        submissions.length > page.limit ? submissions[page.limit - 1].id : null,
    };
  }

  /**
   * Exports one report page as spreadsheet-safe CSV with a separate continuation cursor.
   * @param key Form key. @param version Revision. @param page Pagination settings.
   * @returns CSV text and nextCursor for the response header.
   * @throws The same authorization-independent domain errors as report().
   */
  async csv(key: string, version: number, page: PageDto) {
    const report = await this.report(key, version, page);
    return {
      csv:
        [
          report.columns.map(csvCell).join(','),
          ...report.data.map((row) =>
            report.columns.map((column) => csvCell(row[column])).join(','),
          ),
        ].join('\r\n') + '\r\n',
      nextCursor: report.nextCursor,
    };
  }

  /**
   * Locks the stable form row, serializing schema changes, closure, and idempotent writes.
   * @param tx Current transaction. @param key Form key.
   * @returns Form UUID. @throws NotFoundException when the form does not exist.
   */
  private async lockForm(
    tx: Prisma.TransactionClient,
    key: string,
  ): Promise<string> {
    const forms = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "forms"."Form" WHERE key = ${key} FOR UPDATE`;
    if (!forms[0]) throw new NotFoundException('Form not found.');
    return forms[0].id;
  }

  /**
   * Reads a fully ordered definition for a pinned revision.
   * @param tx Prisma client/transaction. @param key Form key. @param version Revision number.
   * @returns Definition and options. @throws BadRequestException for invalid identifiers; NotFoundException for unknown revisions.
   */
  private async findVersion(
    tx: Prisma.TransactionClient,
    key: string,
    version: number,
  ): Promise<Definition> {
    reportViewName(key, version);
    const definition = await tx.formVersion.findFirst({
      where: { form: { key }, version },
      include: definitionInclude,
    });
    if (!definition) throw new NotFoundException('Form version not found.');
    return definition;
  }

  /**
   * Adds lifecycle and audit metadata to a public definition for trusted editors.
   * @param definition Stored revision. @returns Administration response. @throws No errors for stored definitions.
   */
  private adminDefinition(definition: Definition) {
    return {
      ...publicDefinition(definition),
      status: definition.status,
      createdBy: definition.createdBy,
      publishedBy: definition.publishedBy,
      retiredBy: definition.retiredBy,
      createdAt: definition.createdAt,
      publishedAt: definition.publishedAt,
      retiredAt: definition.retiredAt,
      reportingView: definition.publishedAt
        ? reportViewName(definition.form.key, definition.version)
        : null,
    };
  }

  /**
   * Maps one validated value into exactly one database scalar column or relational choice set.
   * @param tx Transaction. @param submissionId Envelope UUID. @param versionId Revision UUID. @param answer Validated field/value.
   * @returns Completion. @throws Prisma errors on constraint failures, rolling back the complete submission.
   */
  private async writeAnswer(
    tx: Prisma.TransactionClient,
    submissionId: string,
    versionId: string,
    { field, value }: ValidatedAnswer,
  ): Promise<void> {
    const data: Prisma.AnswerUncheckedCreateInput = {
      id: randomUUID(),
      submissionId,
      versionId,
      fieldId: field.id,
      type: field.type,
    };
    switch (field.type) {
      case FieldType.TEXT:
      case FieldType.TEXTAREA:
      case FieldType.EMAIL:
        data.textValue = value as string;
        break;
      case FieldType.INTEGER:
        data.integerValue = value as number;
        break;
      case FieldType.DECIMAL:
        data.decimalValue = value as string;
        break;
      case FieldType.BOOLEAN:
        data.booleanValue = value as boolean;
        break;
      case FieldType.DATE:
        data.dateValue = new Date(`${value as string}T00:00:00.000Z`);
        break;
      case FieldType.SINGLE_SELECT:
        data.optionId = field.options.find((o) => o.key === value)!.id;
        break;
      case FieldType.MULTI_SELECT:
        break;
    }
    await tx.answer.create({ data });
    if (field.type === FieldType.MULTI_SELECT) {
      await tx.answerSelection.createMany({
        data: (value as string[]).map((key) => ({
          answerId: data.id!,
          fieldId: field.id,
          versionId,
          type: FieldType.MULTI_SELECT,
          optionId: field.options.find((o) => o.key === key)!.id,
        })),
      });
    }
  }
}

/**
 * Returns the allowlisted API contract used by CMS blocks and frontend renderers.
 * @param definition Stored revision. @returns Named schema without private audit or storage IDs.
 * @throws No errors for database-valid definitions.
 */
function publicDefinition(definition: Definition) {
  return {
    key: definition.form.key,
    version: definition.version,
    title: definition.title,
    description: definition.description,
    successMessage: definition.successMessage,
    access: definition.access,
    fields: definition.fields.map((f) => ({
      key: f.key,
      label: f.label,
      helpText: f.helpText,
      type: f.type,
      required: f.required,
      maxLength: f.maxLength,
      minValue: f.minValue?.toFixed() ?? null,
      maxValue: f.maxValue?.toFixed() ?? null,
      options: f.options.map((o) => ({ key: o.key, label: o.label })),
    })),
  };
}

/**
 * Hashes a canonical object for definition and request replay protection.
 * @param value Object with deterministic property/array order. @returns SHA-256 hex digest.
 * @throws TypeError if a non-JSON-serializable value is passed; callers supply validated primitives.
 */
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
