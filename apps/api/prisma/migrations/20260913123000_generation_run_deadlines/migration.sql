-- Whole-book queue admission and execution use independent deadlines.
-- Legacy rows receive conservative values derived from durable timestamps;
-- publication, authorization, and credit history are unchanged.
ALTER TABLE "generation_runs"
  ADD COLUMN "queue_expires_at" TIMESTAMP(3),
  ADD COLUMN "processing_deadline_at" TIMESTAMP(3);

UPDATE "generation_runs"
SET "queue_expires_at" = "created_at" + INTERVAL '15 minutes'
WHERE "status" = 'queued';

UPDATE "generation_runs"
SET "processing_deadline_at" = COALESCE("started_at", "created_at") + INTERVAL '45 minutes'
WHERE "status" = 'running';

CREATE INDEX "generation_runs_status_queue_expires_at_idx"
  ON "generation_runs"("status", "queue_expires_at");
