ALTER TABLE "page_image_revisions"
  ADD COLUMN "candidate_image_key" TEXT,
  ADD COLUMN "candidate_image_manifest" JSONB,
  ADD COLUMN "provider_operations" JSONB,
  ADD COLUMN "authorized_dispatches" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "maximum_estimated_exposure_usd" DECIMAL(10,6),
  ADD COLUMN "checkpoint_state" TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN "queue_expires_at" TIMESTAMP(3),
  ADD COLUMN "lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "processing_deadline_at" TIMESTAMP(3),
  ADD COLUMN "failure_reason" TEXT;

CREATE INDEX "page_image_revisions_recovery_idx"
  ON "page_image_revisions" ("status", "queue_expires_at", "lease_expires_at", "processing_deadline_at");

-- Existing queued/running rows deliberately receive no inferred deadline.
-- Recovery treats those legacy rows conservatively and only acts after the
-- existing created/started timestamps exceed configured recovery windows.
