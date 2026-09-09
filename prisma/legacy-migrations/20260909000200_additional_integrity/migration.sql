-- PostgreSQL CHECK considers NULL successful: explicitly require the DATE scalar.
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_date_not_null" CHECK (type <> 'DATE' OR "dateValue" IS NOT NULL);

-- Trigger input: OLD/NEW answer, selection, or form identity. Return: never.
-- Prevents in-place moves between submissions and changing names underpinning report views.
CREATE FUNCTION reject_form_data_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Create a new record instead of changing immutable form data' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER immutable_answer BEFORE UPDATE ON "Answer" FOR EACH ROW EXECUTE FUNCTION reject_form_data_update();
CREATE TRIGGER immutable_selection BEFORE UPDATE ON "AnswerSelection" FOR EACH ROW EXECUTE FUNCTION reject_form_data_update();
CREATE TRIGGER immutable_form_identity BEFORE UPDATE ON "Form" FOR EACH ROW WHEN (OLD.key IS DISTINCT FROM NEW.key OR OLD.id IS DISTINCT FROM NEW.id) EXECUTE FUNCTION reject_form_data_update();
