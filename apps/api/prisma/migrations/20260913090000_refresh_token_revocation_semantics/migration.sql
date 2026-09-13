CREATE TYPE "RefreshTokenRevocationReason" AS ENUM (
  'rotation',
  'logout',
  'password_reset',
  'compromise'
);

ALTER TABLE "refresh_tokens"
  ADD COLUMN "revocation_reason" "RefreshTokenRevocationReason",
  ADD COLUMN "rotated_from_id" UUID;

-- Legacy revocations did not record intent. Treat them conservatively as
-- terminal rather than accidentally granting the new rotation grace period.
UPDATE "refresh_tokens"
SET "revocation_reason" = 'compromise'
WHERE "revoked_at" IS NOT NULL;

CREATE UNIQUE INDEX "refresh_tokens_rotated_from_id_key"
  ON "refresh_tokens"("rotated_from_id");

ALTER TABLE "refresh_tokens"
  ADD CONSTRAINT "refresh_tokens_rotated_from_id_fkey"
  FOREIGN KEY ("rotated_from_id") REFERENCES "refresh_tokens"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
