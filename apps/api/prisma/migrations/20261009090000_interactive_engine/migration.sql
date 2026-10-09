-- Additive: interactive story engine (v2 Phase 1). New tables only; no existing
-- table, column, or row is altered.
CREATE TABLE "interactive_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "scenario_id" TEXT NOT NULL,
    "scenario_version" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "state" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interactive_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "session_events" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "state_hash" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "request_hash" TEXT,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "interactive_sessions_user_id_created_at_idx" ON "interactive_sessions"("user_id", "created_at");

CREATE UNIQUE INDEX "session_events_session_id_seq_key" ON "session_events"("session_id", "seq");

CREATE UNIQUE INDEX "session_events_session_id_idempotency_key_key" ON "session_events"("session_id", "idempotency_key");

ALTER TABLE "interactive_sessions" ADD CONSTRAINT "interactive_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "interactive_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
