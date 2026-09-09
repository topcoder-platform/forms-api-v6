-- Baseline for the forms schema; legacy dedicated-database migrations are archived.
BEGIN;
-- CreateSchema
-- Existing schema owners do not need database-wide CREATE privileges.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'forms') THEN
    CREATE SCHEMA "forms";
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "forms"."FieldType" AS ENUM ('TEXT', 'TEXTAREA', 'EMAIL', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'DATE', 'SINGLE_SELECT', 'MULTI_SELECT');

-- CreateEnum
CREATE TYPE "forms"."FormStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "forms"."FormAccess" AS ENUM ('ANONYMOUS', 'MEMBER');

-- CreateTable
CREATE TABLE "forms"."Form" (
    "id" UUID NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Form_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forms"."FormVersion" (
    "id" UUID NOT NULL,
    "formId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000),
    "successMessage" VARCHAR(1000) NOT NULL,
    "access" "forms"."FormAccess" NOT NULL DEFAULT 'ANONYMOUS',
    "status" "forms"."FormStatus" NOT NULL DEFAULT 'DRAFT',
    "definitionHash" CHAR(64) NOT NULL,
    "createdBy" VARCHAR(200) NOT NULL,
    "publishedBy" VARCHAR(200),
    "retiredBy" VARCHAR(200),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),
    "retiredAt" TIMESTAMPTZ(3),

    CONSTRAINT "FormVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forms"."FormField" (
    "id" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "helpText" VARCHAR(1000),
    "type" "forms"."FieldType" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,
    "maxLength" INTEGER,
    "minValue" DECIMAL(20,6),
    "maxValue" DECIMAL(20,6),

    CONSTRAINT "FormField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forms"."FieldOption" (
    "id" UUID NOT NULL,
    "fieldId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "FieldOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forms"."Submission" (
    "id" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "memberId" VARCHAR(200),
    "sourcePage" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forms"."Answer" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "fieldId" UUID NOT NULL,
    "type" "forms"."FieldType" NOT NULL,
    "textValue" VARCHAR(10000),
    "integerValue" INTEGER,
    "decimalValue" DECIMAL(20,6),
    "booleanValue" BOOLEAN,
    "dateValue" DATE,
    "optionId" UUID,

    CONSTRAINT "Answer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forms"."AnswerSelection" (
    "answerId" UUID NOT NULL,
    "fieldId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "type" "forms"."FieldType" NOT NULL DEFAULT 'MULTI_SELECT',
    "optionId" UUID NOT NULL,

    CONSTRAINT "AnswerSelection_pkey" PRIMARY KEY ("answerId","optionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Form_key_key" ON "forms"."Form"("key");

-- CreateIndex
CREATE UNIQUE INDEX "FormVersion_formId_version_key" ON "forms"."FormVersion"("formId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "FormField_versionId_key_key" ON "forms"."FormField"("versionId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "FormField_versionId_position_key" ON "forms"."FormField"("versionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "FormField_id_versionId_type_key" ON "forms"."FormField"("id", "versionId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "FormField_id_versionId_key" ON "forms"."FormField"("id", "versionId");

-- CreateIndex
CREATE UNIQUE INDEX "FieldOption_fieldId_key_key" ON "forms"."FieldOption"("fieldId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "FieldOption_fieldId_position_key" ON "forms"."FieldOption"("fieldId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "FieldOption_id_fieldId_versionId_key" ON "forms"."FieldOption"("id", "fieldId", "versionId");

-- CreateIndex
CREATE INDEX "Submission_versionId_createdAt_id_idx" ON "forms"."Submission"("versionId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_versionId_idempotencyKey_key" ON "forms"."Submission"("versionId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_id_versionId_key" ON "forms"."Submission"("id", "versionId");

-- CreateIndex
CREATE INDEX "Answer_fieldId_idx" ON "forms"."Answer"("fieldId");

-- CreateIndex
CREATE UNIQUE INDEX "Answer_submissionId_fieldId_key" ON "forms"."Answer"("submissionId", "fieldId");

-- CreateIndex
CREATE UNIQUE INDEX "Answer_id_fieldId_versionId_type_key" ON "forms"."Answer"("id", "fieldId", "versionId", "type");

-- CreateIndex
CREATE INDEX "AnswerSelection_optionId_idx" ON "forms"."AnswerSelection"("optionId");

-- AddForeignKey
ALTER TABLE "forms"."FormVersion" ADD CONSTRAINT "FormVersion_formId_fkey" FOREIGN KEY ("formId") REFERENCES "forms"."Form"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms"."FormField" ADD CONSTRAINT "FormField_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "forms"."FormVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms"."FieldOption" ADD CONSTRAINT "FieldOption_fieldId_versionId_fkey" FOREIGN KEY ("fieldId", "versionId") REFERENCES "forms"."FormField"("id", "versionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms"."Submission" ADD CONSTRAINT "Submission_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "forms"."FormVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms"."Answer" ADD CONSTRAINT "Answer_submissionId_versionId_fkey" FOREIGN KEY ("submissionId", "versionId") REFERENCES "forms"."Submission"("id", "versionId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms"."Answer" ADD CONSTRAINT "Answer_fieldId_versionId_type_fkey" FOREIGN KEY ("fieldId", "versionId", "type") REFERENCES "forms"."FormField"("id", "versionId", "type") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms"."Answer" ADD CONSTRAINT "Answer_optionId_fieldId_versionId_fkey" FOREIGN KEY ("optionId", "fieldId", "versionId") REFERENCES "forms"."FieldOption"("id", "fieldId", "versionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms"."AnswerSelection" ADD CONSTRAINT "AnswerSelection_answerId_fieldId_versionId_type_fkey" FOREIGN KEY ("answerId", "fieldId", "versionId", "type") REFERENCES "forms"."Answer"("id", "fieldId", "versionId", "type") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms"."AnswerSelection" ADD CONSTRAINT "AnswerSelection_optionId_fieldId_versionId_fkey" FOREIGN KEY ("optionId", "fieldId", "versionId") REFERENCES "forms"."FieldOption"("id", "fieldId", "versionId") ON DELETE RESTRICT ON UPDATE CASCADE;

REVOKE ALL ON SCHEMA "forms" FROM PUBLIC;

ALTER TABLE "forms"."Form" ADD CONSTRAINT "Form_key_safe" CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$');
ALTER TABLE "forms"."FormVersion" ADD CONSTRAINT "FormVersion_number_valid" CHECK (version BETWEEN 1 AND 1000000);
CREATE UNIQUE INDEX "FormVersion_one_published" ON "forms"."FormVersion" ("formId") WHERE status = 'PUBLISHED';
ALTER TABLE "forms"."FormField" ADD CONSTRAINT "FormField_definition_valid" CHECK (
  key ~ '^[a-z][a-z0-9_]{0,39}$'
  AND key NOT IN ('submission_id', 'submitted_at', 'member_id', 'source_page', 'form_version')
  AND position >= 0
  AND ("maxLength" IS NULL OR (type IN ('TEXT', 'TEXTAREA', 'EMAIL') AND "maxLength" BETWEEN 1 AND 10000))
  AND (("minValue" IS NULL AND "maxValue" IS NULL) OR type IN ('INTEGER', 'DECIMAL'))
  AND ("minValue" IS NULL OR "maxValue" IS NULL OR "minValue" <= "maxValue")
);
ALTER TABLE "forms"."FieldOption" ADD CONSTRAINT "FieldOption_key_safe" CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$' AND position >= 0);
ALTER TABLE "forms"."AnswerSelection" ADD CONSTRAINT "AnswerSelection_multi_only" CHECK (type = 'MULTI_SELECT');
ALTER TABLE "forms"."Answer" ADD CONSTRAINT "Answer_typed_value" CHECK (
  (type IN ('TEXT', 'TEXTAREA', 'EMAIL') AND "textValue" IS NOT NULL AND num_nonnulls("textValue", "integerValue", "decimalValue", "booleanValue", "dateValue", "optionId") = 1)
  OR (type = 'INTEGER' AND "integerValue" IS NOT NULL AND num_nonnulls("textValue", "integerValue", "decimalValue", "booleanValue", "dateValue", "optionId") = 1)
  OR (type = 'DECIMAL' AND "decimalValue" IS NOT NULL AND "decimalValue" <> 'NaN'::numeric AND num_nonnulls("textValue", "integerValue", "decimalValue", "booleanValue", "dateValue", "optionId") = 1)
  OR (type = 'BOOLEAN' AND "booleanValue" IS NOT NULL AND num_nonnulls("textValue", "integerValue", "decimalValue", "booleanValue", "dateValue", "optionId") = 1)
  OR (type = 'DATE' AND "dateValue" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' AND num_nonnulls("textValue", "integerValue", "decimalValue", "booleanValue", "dateValue", "optionId") = 1)
  OR (type = 'SINGLE_SELECT' AND "optionId" IS NOT NULL AND num_nonnulls("textValue", "integerValue", "decimalValue", "booleanValue", "dateValue", "optionId") = 1)
  OR (type = 'MULTI_SELECT' AND num_nonnulls("textValue", "integerValue", "decimalValue", "booleanValue", "dateValue", "optionId") = 0)
);

-- Trigger input: OLD/NEW field/option row. Return: row. Raises check_violation for
-- edits to published/retired definitions. Locks the version against concurrent publication.
CREATE FUNCTION "forms"."protect_form_definition"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, forms AS $$
DECLARE version_status "forms"."FormStatus";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT status INTO version_status FROM "forms"."FormVersion" WHERE id = OLD."versionId" FOR SHARE;
    IF version_status <> 'DRAFT' THEN RAISE EXCEPTION 'Published definitions are immutable' USING ERRCODE = '23514'; END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT status INTO version_status FROM "forms"."FormVersion" WHERE id = NEW."versionId" FOR SHARE;
    IF version_status <> 'DRAFT' THEN RAISE EXCEPTION 'Published definitions are immutable' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER protect_fields BEFORE INSERT OR UPDATE OR DELETE ON "forms"."FormField" FOR EACH ROW EXECUTE FUNCTION "forms"."protect_form_definition"();
CREATE TRIGGER protect_options BEFORE INSERT OR UPDATE OR DELETE ON "forms"."FieldOption" FOR EACH ROW EXECUTE FUNCTION "forms"."protect_form_definition"();

-- Trigger input: old/new version. Return: row. Raises check_violation for invalid
-- lifecycle transitions or changing immutable published definition metadata.
CREATE FUNCTION "forms"."protect_form_version"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, forms AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'Published versions cannot be deleted' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'DRAFT' AND ROW(NEW."formId", NEW.version, NEW.title, NEW.description, NEW."successMessage", NEW.access, NEW."definitionHash", NEW."createdBy", NEW."createdAt", NEW."publishedAt", NEW."publishedBy") IS DISTINCT FROM
    ROW(OLD."formId", OLD.version, OLD.title, OLD.description, OLD."successMessage", OLD.access, OLD."definitionHash", OLD."createdBy", OLD."createdAt", OLD."publishedAt", OLD."publishedBy") THEN
    RAISE EXCEPTION 'Published versions are immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.status = 'RETIRED' AND NEW.status <> 'RETIRED') OR (OLD.status = 'PUBLISHED' AND NEW.status = 'DRAFT') OR (OLD.status = 'DRAFT' AND NEW.status = 'RETIRED') THEN
    RAISE EXCEPTION 'Invalid version transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_versions BEFORE UPDATE OR DELETE ON "forms"."FormVersion" FOR EACH ROW EXECUTE FUNCTION "forms"."protect_form_version"();

-- Trigger input: submission envelope. Return: new row. Raises check_violation when
-- writes target an unpublished version or a member form has no verified identity.
CREATE FUNCTION "forms"."validate_submission_envelope"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, forms AS $$
DECLARE definition "forms"."FormVersion";
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Submissions are immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO definition FROM "forms"."FormVersion" WHERE id = NEW."versionId" FOR SHARE;
  IF definition.status <> 'PUBLISHED' THEN RAISE EXCEPTION 'Form is not published' USING ERRCODE = '23514'; END IF;
  IF definition.access = 'MEMBER' AND (NEW."memberId" IS NULL OR NEW."memberId" = '') THEN RAISE EXCEPTION 'Member identity is required' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER validate_submission BEFORE INSERT OR UPDATE ON "forms"."Submission" FOR EACH ROW EXECUTE FUNCTION "forms"."validate_submission_envelope"();

-- Deferred trigger input: a submission or changed answer/selection. Return: null.
-- Called after the transaction has written all children; raises check_violation for
-- missing required answers, empty selections, or violations of configured bounds.
CREATE FUNCTION "forms"."validate_complete_submission"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, forms AS $$
DECLARE submission_id uuid; version_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'Submission' THEN submission_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'Answer' THEN
    IF TG_OP = 'DELETE' THEN submission_id := OLD."submissionId"; ELSE submission_id := NEW."submissionId"; END IF;
  ELSE
    SELECT "submissionId" INTO submission_id FROM "forms"."Answer" WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD."answerId" ELSE NEW."answerId" END;
  END IF;
  SELECT "versionId" INTO version_id FROM "forms"."Submission" WHERE id = submission_id;
  IF version_id IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (
    SELECT 1 FROM "forms"."FormField" f WHERE f."versionId" = version_id AND f.required
    AND NOT EXISTS (SELECT 1 FROM "forms"."Answer" a WHERE a."submissionId" = submission_id AND a."fieldId" = f.id)
  ) THEN RAISE EXCEPTION 'Required answer missing' USING ERRCODE = '23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM "forms"."Answer" a JOIN "forms"."FormField" f ON f.id = a."fieldId" WHERE a."submissionId" = submission_id AND (
      (a.type IN ('TEXT', 'TEXTAREA', 'EMAIL') AND (length(btrim(a."textValue")) = 0 OR length(a."textValue") > coalesce(f."maxLength", 10000)))
      OR (a.type IN ('INTEGER', 'DECIMAL') AND (coalesce(a."decimalValue", a."integerValue") < f."minValue" OR coalesce(a."decimalValue", a."integerValue") > f."maxValue"))
      OR (a.type = 'MULTI_SELECT' AND NOT EXISTS (SELECT 1 FROM "forms"."AnswerSelection" s WHERE s."answerId" = a.id))
    )
  ) THEN RAISE EXCEPTION 'Answer violates field rules' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER complete_submission AFTER INSERT ON "forms"."Submission" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "forms"."validate_complete_submission"();
CREATE CONSTRAINT TRIGGER complete_answer AFTER INSERT OR UPDATE OR DELETE ON "forms"."Answer" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "forms"."validate_complete_submission"();
CREATE CONSTRAINT TRIGGER complete_selection AFTER INSERT OR UPDATE OR DELETE ON "forms"."AnswerSelection" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "forms"."validate_complete_submission"();

COMMENT ON SCHEMA forms IS 'Forms API tables, enums, integrity functions, and named per-version reporting views.';
COMMENT ON TABLE "forms"."Answer" IS 'Exactly one typed scalar or a relational multi-select set. Composite foreign keys prohibit cross-form answers.';

-- PostgreSQL CHECK considers NULL successful: explicitly require the DATE scalar.
ALTER TABLE "forms"."Answer" ADD CONSTRAINT "Answer_date_not_null" CHECK (type <> 'DATE' OR "dateValue" IS NOT NULL);

-- Trigger input: OLD/NEW answer, selection, or form identity. Return: never.
-- Prevents in-place moves between submissions and changing names underpinning report views.
CREATE FUNCTION "forms"."reject_form_data_update"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, forms AS $$
BEGIN
  RAISE EXCEPTION 'Create a new record instead of changing immutable form data' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER immutable_answer BEFORE UPDATE ON "forms"."Answer" FOR EACH ROW EXECUTE FUNCTION "forms"."reject_form_data_update"();
CREATE TRIGGER immutable_selection BEFORE UPDATE ON "forms"."AnswerSelection" FOR EACH ROW EXECUTE FUNCTION "forms"."reject_form_data_update"();
CREATE TRIGGER immutable_form_identity BEFORE UPDATE ON "forms"."Form" FOR EACH ROW WHEN (OLD.key IS DISTINCT FROM NEW.key OR OLD.id IS DISTINCT FROM NEW.id) EXECUTE FUNCTION "forms"."reject_form_data_update"();

COMMIT;
