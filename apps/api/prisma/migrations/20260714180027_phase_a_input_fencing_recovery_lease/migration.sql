-- AlterTable
ALTER TABLE "books" ADD COLUMN     "child_photo_sha256" TEXT,
ADD COLUMN     "child_photo_size_bytes" INTEGER;

-- AlterTable
ALTER TABLE "generation_runs" ADD COLUMN     "lease_attempt" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "recovery_leases" (
    "id" TEXT NOT NULL,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recovery_leases_pkey" PRIMARY KEY ("id")
);

-- Seed the single row every instance contends over via a conditional UPDATE
-- (see GenerationRunRecoveryService) — created here so there is no
-- first-ever-acquire race between independent instances trying to insert it.
INSERT INTO "recovery_leases" ("id", "lease_owner", "lease_expires_at", "updated_at")
VALUES ('generation_run_recovery', NULL, NULL, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
