-- GenerationRun has been the authoritative lifecycle for dispatch, fencing,
-- recovery, cancellation, charging, publication, and diagnostics. Runtime
-- GenerationJob reads and writes were removed before this migration.
ALTER TABLE "generation_jobs"
DROP CONSTRAINT "generation_jobs_book_id_fkey";

DROP TABLE "generation_jobs";

DROP TYPE "GenerationJobStatus";
DROP TYPE "GenerationJobType";
