-- Phase 3I: generation job tracking table
-- CreateEnum
CREATE TYPE "GenerationJobType" AS ENUM ('generate', 'retry');

-- CreateEnum
CREATE TYPE "GenerationJobStatus" AS ENUM ('queued', 'running', 'completed', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "generation_jobs" (
    "id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "GenerationJobType" NOT NULL,
    "status" "GenerationJobStatus" NOT NULL DEFAULT 'queued',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "max_attempts" INTEGER,
    "failed_step" "AgentStep",
    "error_message" TEXT,
    "runner_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generation_jobs_book_id_idx" ON "generation_jobs"("book_id");

-- CreateIndex
CREATE INDEX "generation_jobs_book_id_status_idx" ON "generation_jobs"("book_id", "status");

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;
