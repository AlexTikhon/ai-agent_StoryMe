CREATE TYPE "BookDeletionStatus" AS ENUM ('requested', 'processing', 'retry_pending', 'completed');

CREATE TABLE "book_deletion_requests" (
    "id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "owner_hash" TEXT NOT NULL,
    "requested_by_role" "UserRole" NOT NULL,
    "status" "BookDeletionStatus" NOT NULL DEFAULT 'requested',
    "private_data_retention_days" INTEGER NOT NULL,
    "generated_artifact_retention_days" INTEGER NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "deleted_artifact_count" INTEGER NOT NULL DEFAULT 0,
    "remaining_artifact_count" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "book_deletion_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "book_deletion_requests_nonnegative_counts" CHECK (
      "private_data_retention_days" >= 0
      AND "generated_artifact_retention_days" >= 0
      AND "attempt_count" >= 0
      AND "deleted_artifact_count" >= 0
      AND "remaining_artifact_count" >= 0
    )
);

CREATE UNIQUE INDEX "book_deletion_requests_book_id_key"
ON "book_deletion_requests"("book_id");

CREATE INDEX "book_deletion_requests_status_requested_at_idx"
ON "book_deletion_requests"("status", "requested_at");
