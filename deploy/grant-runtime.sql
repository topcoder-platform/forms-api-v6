-- Run after each migration as forms_migrator. Runtime can publish reporting views,
-- but cannot change the service tables or Prisma migration history.
GRANT USAGE ON SCHEMA public TO forms_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "Form", "FormVersion", "FormField", "FieldOption", "Submission", "Answer", "AnswerSelection"
  TO forms_runtime;
GRANT USAGE, CREATE ON SCHEMA forms_reporting TO forms_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE forms_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO forms_runtime;
REVOKE ALL ON TABLE "_prisma_migrations" FROM forms_runtime;
