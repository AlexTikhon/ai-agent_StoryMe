-- Existing pending events remain immediately eligible. No payload is copied.
ALTER TABLE "outbox_events"
  ADD COLUMN "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "quarantined_at" TIMESTAMP(3),
  ADD COLUMN "last_failure_code" TEXT;

DROP INDEX "outbox_events_status_created_at_idx";
CREATE INDEX "outbox_events_status_next_attempt_at_created_at_idx"
  ON "outbox_events"("status", "next_attempt_at", "created_at");
