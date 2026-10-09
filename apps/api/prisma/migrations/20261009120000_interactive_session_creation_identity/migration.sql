-- Additive: creation identity for interactive sessions. Both columns are nullable
-- so existing sessions stay valid; PostgreSQL unique indexes treat NULLs as
-- distinct, so rows without a key never collide. No existing column, row or
-- migration is altered.
ALTER TABLE "interactive_sessions" ADD COLUMN "creation_idempotency_key" TEXT;
ALTER TABLE "interactive_sessions" ADD COLUMN "creation_request_hash" TEXT;

CREATE UNIQUE INDEX "interactive_sessions_user_id_creation_idempotency_key_key" ON "interactive_sessions"("user_id", "creation_idempotency_key");
