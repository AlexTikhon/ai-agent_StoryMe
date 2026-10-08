-- Additive: durable admission records for API-side artifact writers so permanent
-- book deletion can account for in-flight writes. No existing data is touched.
CREATE TYPE "BookArtifactWriteState" AS ENUM ('active', 'cleanup_pending');

CREATE TABLE "book_artifact_write_intents" (
  "id" UUID NOT NULL,
  "book_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "artifacts" JSONB NOT NULL,
  "state" "BookArtifactWriteState" NOT NULL DEFAULT 'active',
  "lease_expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "book_artifact_write_intents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "book_artifact_write_intents_book_id_state_idx"
  ON "book_artifact_write_intents"("book_id", "state");
CREATE INDEX "book_artifact_write_intents_state_lease_expires_at_idx"
  ON "book_artifact_write_intents"("state", "lease_expires_at");
