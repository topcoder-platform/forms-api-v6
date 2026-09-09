CREATE SCHEMA forms_reporting;
REVOKE ALL ON SCHEMA forms_reporting FROM PUBLIC;

ALTER TABLE "Form" ADD CONSTRAINT "Form_key_safe" CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$');
ALTER TABLE "FormVersion" ADD CONSTRAINT "FormVersion_number_valid" CHECK (version BETWEEN 1 AND 1000000);
CREATE UNIQUE INDEX "FormVersion_one_published" ON "FormVersion" ("formId") WHERE status = 'PUBLISHED';
ALTER TABLE "FormField" ADD CONSTRAINT "FormField_definition_valid" CHECK (
  key ~ '^[a-z][a-z0-9_]{0,39}$'
  AND key NOT IN ('submission_id', 'submitted_at', 'member_id', 'source_page', 'form_version')
  AND position >= 0
  AND ("maxLength" IS NULL OR (type IN ('TEXT', 'TEXTAREA', 'EMAIL') AND "maxLength" BETWEEN 1 AND 10000))
  AND (("minValue" IS NULL AND "maxValue" IS NULL) OR type IN ('INTEGER', 'DECIMAL'))
  AND ("minValue" IS NULL OR "maxValue" IS NULL OR "minValue" <= "maxValue")
);
ALTER TABLE "FieldOption" ADD CONSTRAINT "FieldOption_key_safe" CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$' AND position >= 0);
ALTER TABLE "AnswerSelection" ADD CONSTRAINT "AnswerSelection_multi_only" CHECK (type = 'MULTI_SELECT');
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_typed_value" CHECK (
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
CREATE FUNCTION protect_form_definition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version_status "FormStatus";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT status INTO version_status FROM "FormVersion" WHERE id = OLD."versionId" FOR SHARE;
    IF version_status <> 'DRAFT' THEN RAISE EXCEPTION 'Published definitions are immutable' USING ERRCODE = '23514'; END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT status INTO version_status FROM "FormVersion" WHERE id = NEW."versionId" FOR SHARE;
    IF version_status <> 'DRAFT' THEN RAISE EXCEPTION 'Published definitions are immutable' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER protect_fields BEFORE INSERT OR UPDATE OR DELETE ON "FormField" FOR EACH ROW EXECUTE FUNCTION protect_form_definition();
CREATE TRIGGER protect_options BEFORE INSERT OR UPDATE OR DELETE ON "FieldOption" FOR EACH ROW EXECUTE FUNCTION protect_form_definition();

-- Trigger input: old/new version. Return: row. Raises check_violation for invalid
-- lifecycle transitions or changing immutable published definition metadata.
CREATE FUNCTION protect_form_version() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER protect_versions BEFORE UPDATE OR DELETE ON "FormVersion" FOR EACH ROW EXECUTE FUNCTION protect_form_version();

-- Trigger input: submission envelope. Return: new row. Raises check_violation when
-- writes target an unpublished version or a member form has no verified identity.
CREATE FUNCTION validate_submission_envelope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition "FormVersion";
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Submissions are immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO definition FROM "FormVersion" WHERE id = NEW."versionId" FOR SHARE;
  IF definition.status <> 'PUBLISHED' THEN RAISE EXCEPTION 'Form is not published' USING ERRCODE = '23514'; END IF;
  IF definition.access = 'MEMBER' AND (NEW."memberId" IS NULL OR NEW."memberId" = '') THEN RAISE EXCEPTION 'Member identity is required' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER validate_submission BEFORE INSERT OR UPDATE ON "Submission" FOR EACH ROW EXECUTE FUNCTION validate_submission_envelope();

-- Deferred trigger input: a submission or changed answer/selection. Return: null.
-- Called after the transaction has written all children; raises check_violation for
-- missing required answers, empty selections, or violations of configured bounds.
CREATE FUNCTION validate_complete_submission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submission_id uuid; version_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'Submission' THEN submission_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'Answer' THEN
    IF TG_OP = 'DELETE' THEN submission_id := OLD."submissionId"; ELSE submission_id := NEW."submissionId"; END IF;
  ELSE
    SELECT "submissionId" INTO submission_id FROM "Answer" WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD."answerId" ELSE NEW."answerId" END;
  END IF;
  SELECT "versionId" INTO version_id FROM "Submission" WHERE id = submission_id;
  IF version_id IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (
    SELECT 1 FROM "FormField" f WHERE f."versionId" = version_id AND f.required
    AND NOT EXISTS (SELECT 1 FROM "Answer" a WHERE a."submissionId" = submission_id AND a."fieldId" = f.id)
  ) THEN RAISE EXCEPTION 'Required answer missing' USING ERRCODE = '23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM "Answer" a JOIN "FormField" f ON f.id = a."fieldId" WHERE a."submissionId" = submission_id AND (
      (a.type IN ('TEXT', 'TEXTAREA', 'EMAIL') AND (length(btrim(a."textValue")) = 0 OR length(a."textValue") > coalesce(f."maxLength", 10000)))
      OR (a.type IN ('INTEGER', 'DECIMAL') AND (coalesce(a."decimalValue", a."integerValue") < f."minValue" OR coalesce(a."decimalValue", a."integerValue") > f."maxValue"))
      OR (a.type = 'MULTI_SELECT' AND NOT EXISTS (SELECT 1 FROM "AnswerSelection" s WHERE s."answerId" = a.id))
    )
  ) THEN RAISE EXCEPTION 'Answer violates field rules' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER complete_submission AFTER INSERT ON "Submission" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_complete_submission();
CREATE CONSTRAINT TRIGGER complete_answer AFTER INSERT OR UPDATE OR DELETE ON "Answer" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_complete_submission();
CREATE CONSTRAINT TRIGGER complete_selection AFTER INSERT OR UPDATE OR DELETE ON "AnswerSelection" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_complete_submission();

COMMENT ON SCHEMA forms_reporting IS 'Read-only named, typed per-form-version views created atomically during publication.';
COMMENT ON TABLE "Answer" IS 'Exactly one typed scalar or a relational multi-select set. Composite foreign keys prohibit cross-form answers.';
