-- Track Bus API delivery without changing immutable submission envelopes.
CREATE TABLE "forms"."SubmissionEvent" (
    "submissionId" UUID NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    CONSTRAINT "SubmissionEvent_pkey" PRIMARY KEY ("submissionId"),
    CONSTRAINT "SubmissionEvent_submissionId_fkey" FOREIGN KEY ("submissionId")
        REFERENCES "forms"."Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
