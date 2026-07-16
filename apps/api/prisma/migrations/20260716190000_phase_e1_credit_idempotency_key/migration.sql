-- Phase E1 — atomic credit accounting foundation: adds a nullable, unique
-- idempotency key to credit_transactions so a future caller that must apply
-- a mutation at most once (a Stripe webhook redelivery, a refund retried
-- after a client timeout) gets a DB-enforced single-insert guarantee rather
-- than a check-then-insert race. Most rows have no idempotency requirement
-- and leave this null; Postgres treats multiple NULLs in a unique column as
-- distinct, so this never collides for those rows.
ALTER TABLE "credit_transactions" ADD COLUMN     "idempotency_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "credit_transactions_idempotency_key_key" ON "credit_transactions"("idempotency_key");
