-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('TEXT', 'TEXTAREA', 'EMAIL', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'DATE', 'SINGLE_SELECT', 'MULTI_SELECT');

-- CreateEnum
CREATE TYPE "FormStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "FormAccess" AS ENUM ('ANONYMOUS', 'MEMBER');

-- CreateTable
CREATE TABLE "Form" (
    "id" UUID NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Form_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormVersion" (
    "id" UUID NOT NULL,
    "formId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000),
    "successMessage" VARCHAR(1000) NOT NULL,
    "access" "FormAccess" NOT NULL DEFAULT 'ANONYMOUS',
    "status" "FormStatus" NOT NULL DEFAULT 'DRAFT',
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
CREATE TABLE "FormField" (
    "id" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "helpText" VARCHAR(1000),
    "type" "FieldType" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,
    "maxLength" INTEGER,
    "minValue" DECIMAL(20,6),
    "maxValue" DECIMAL(20,6),

    CONSTRAINT "FormField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldOption" (
    "id" UUID NOT NULL,
    "fieldId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "FieldOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
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
CREATE TABLE "Answer" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "fieldId" UUID NOT NULL,
    "type" "FieldType" NOT NULL,
    "textValue" VARCHAR(10000),
    "integerValue" INTEGER,
    "decimalValue" DECIMAL(20,6),
    "booleanValue" BOOLEAN,
    "dateValue" DATE,
    "optionId" UUID,

    CONSTRAINT "Answer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnswerSelection" (
    "answerId" UUID NOT NULL,
    "fieldId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "type" "FieldType" NOT NULL DEFAULT 'MULTI_SELECT',
    "optionId" UUID NOT NULL,

    CONSTRAINT "AnswerSelection_pkey" PRIMARY KEY ("answerId","optionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Form_key_key" ON "Form"("key");

-- CreateIndex
CREATE UNIQUE INDEX "FormVersion_formId_version_key" ON "FormVersion"("formId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "FormField_versionId_key_key" ON "FormField"("versionId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "FormField_versionId_position_key" ON "FormField"("versionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "FormField_id_versionId_type_key" ON "FormField"("id", "versionId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "FormField_id_versionId_key" ON "FormField"("id", "versionId");

-- CreateIndex
CREATE UNIQUE INDEX "FieldOption_fieldId_key_key" ON "FieldOption"("fieldId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "FieldOption_fieldId_position_key" ON "FieldOption"("fieldId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "FieldOption_id_fieldId_versionId_key" ON "FieldOption"("id", "fieldId", "versionId");

-- CreateIndex
CREATE INDEX "Submission_versionId_createdAt_id_idx" ON "Submission"("versionId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_versionId_idempotencyKey_key" ON "Submission"("versionId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_id_versionId_key" ON "Submission"("id", "versionId");

-- CreateIndex
CREATE INDEX "Answer_fieldId_idx" ON "Answer"("fieldId");

-- CreateIndex
CREATE UNIQUE INDEX "Answer_submissionId_fieldId_key" ON "Answer"("submissionId", "fieldId");

-- CreateIndex
CREATE UNIQUE INDEX "Answer_id_fieldId_versionId_type_key" ON "Answer"("id", "fieldId", "versionId", "type");

-- CreateIndex
CREATE INDEX "AnswerSelection_optionId_idx" ON "AnswerSelection"("optionId");

-- AddForeignKey
ALTER TABLE "FormVersion" ADD CONSTRAINT "FormVersion_formId_fkey" FOREIGN KEY ("formId") REFERENCES "Form"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormField" ADD CONSTRAINT "FormField_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "FormVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldOption" ADD CONSTRAINT "FieldOption_fieldId_versionId_fkey" FOREIGN KEY ("fieldId", "versionId") REFERENCES "FormField"("id", "versionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "FormVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_submissionId_versionId_fkey" FOREIGN KEY ("submissionId", "versionId") REFERENCES "Submission"("id", "versionId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_fieldId_versionId_type_fkey" FOREIGN KEY ("fieldId", "versionId", "type") REFERENCES "FormField"("id", "versionId", "type") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_optionId_fieldId_versionId_fkey" FOREIGN KEY ("optionId", "fieldId", "versionId") REFERENCES "FieldOption"("id", "fieldId", "versionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerSelection" ADD CONSTRAINT "AnswerSelection_answerId_fieldId_versionId_type_fkey" FOREIGN KEY ("answerId", "fieldId", "versionId", "type") REFERENCES "Answer"("id", "fieldId", "versionId", "type") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerSelection" ADD CONSTRAINT "AnswerSelection_optionId_fieldId_versionId_fkey" FOREIGN KEY ("optionId", "fieldId", "versionId") REFERENCES "FieldOption"("id", "fieldId", "versionId") ON DELETE RESTRICT ON UPDATE CASCADE;
