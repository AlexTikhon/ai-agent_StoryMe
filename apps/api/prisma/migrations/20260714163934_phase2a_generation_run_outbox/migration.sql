-- CreateEnum
CREATE TYPE "GenerationRunKind" AS ENUM ('initial', 'retry', 'regenerate');

-- CreateEnum
CREATE TYPE "GenerationRunStatus" AS ENUM ('queued', 'running', 'completed', 'failed');

-- AlterTable
ALTER TABLE "books" ADD COLUMN     "active_run_id" UUID,
ADD COLUMN     "published_run_id" UUID;

-- CreateTable
CREATE TABLE "generation_runs" (
    "id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "GenerationRunKind" NOT NULL,
    "status" "GenerationRunStatus" NOT NULL DEFAULT 'queued',
    "input_snapshot" JSONB NOT NULL,
    "input_hash" TEXT NOT NULL,
    "retry_of_run_id" UUID,
    "current_step" "AgentStep",
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "fencing_version" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generation_runs_book_id_idx" ON "generation_runs"("book_id");

-- CreateIndex
CREATE INDEX "generation_runs_user_id_idx" ON "generation_runs"("user_id");

-- CreateIndex
CREATE INDEX "outbox_events_status_created_at_idx" ON "outbox_events"("status", "created_at");

-- AddForeignKey
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Invariant A: at most one active (queued/running) GenerationRun per book,
-- enforced at the database level rather than only in application code.
-- Prisma has no native syntax for a conditional/partial unique index, so
-- this is hand-added — not model-driven, and therefore must be preserved by
-- hand in any future migration that touches this table.
CREATE UNIQUE INDEX "generation_runs_one_active_per_book"
ON "generation_runs"("book_id")
WHERE "status" IN ('queued', 'running');
