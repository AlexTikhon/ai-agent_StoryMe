-- Phase 6G: password reset fields on users
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "password_reset_token_hash" TEXT,
ADD COLUMN     "password_reset_expires_at" TIMESTAMP(3),
ADD COLUMN     "password_reset_requested_at" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "users_password_reset_token_hash_key" ON "users"("password_reset_token_hash");
