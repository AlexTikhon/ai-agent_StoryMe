-- AlterTable
ALTER TABLE "books" ADD COLUMN     "last_generation_fencing_version" INTEGER,
ADD COLUMN     "last_generation_run_id" UUID,
ADD COLUMN     "published_run_fencing_version" INTEGER;

-- Phase B, Slice B1 — artifact-namespace pointer invariants. Prisma has no
-- native CHECK-constraint syntax, so these are hand-added (not model-driven)
-- and must be preserved by hand in any future migration that touches
-- "books". No row is backfilled: every existing row keeps all four pointer
-- fields null/as-is, which correctly means "legacy positional artifact
-- storage" (see generation-artifact-namespace.ts).

-- Invariant 1: lastGenerationRunId/lastGenerationFencingVersion identify one
-- exact claim together — a run id without a fencing version (or vice versa)
-- can never resolve to a real artifact namespace, so half-set is invalid.
ALTER TABLE "books" ADD CONSTRAINT "books_last_generation_pointer_pair_chk"
CHECK (
  ("last_generation_run_id" IS NULL AND "last_generation_fencing_version" IS NULL)
  OR ("last_generation_run_id" IS NOT NULL AND "last_generation_fencing_version" IS NOT NULL)
);

-- Invariant 2: GenerationRun.fencingVersion starts at 0 and is only ever
-- incremented by a guarded claim/heartbeat/recovery-forced-failure before a
-- run can produce Phase-1 output — a stored fencing version of 0 or less
-- could never correspond to an actual claim.
ALTER TABLE "books" ADD CONSTRAINT "books_last_generation_fencing_version_positive_chk"
CHECK ("last_generation_fencing_version" IS NULL OR "last_generation_fencing_version" > 0);

-- Invariant 3: publishedRunFencingVersion only disambiguates *which* claim of
-- publishedRunId was published — it is meaningless without a publishedRunId.
-- Deliberately NOT required to be non-null whenever publishedRunId is set:
-- a pre-Phase-B row can have a publishedRunId with a still-null fencing
-- version, meaning "published under legacy positional storage" — that is a
-- valid, permanent state, not a gap to close.
ALTER TABLE "books" ADD CONSTRAINT "books_published_run_fencing_version_requires_run_chk"
CHECK ("published_run_fencing_version" IS NULL OR "published_run_id" IS NOT NULL);

-- Invariant 4: same reasoning as Invariant 2, for the published pointer.
ALTER TABLE "books" ADD CONSTRAINT "books_published_run_fencing_version_positive_chk"
CHECK ("published_run_fencing_version" IS NULL OR "published_run_fencing_version" > 0);
