-- Additive: soft removal of interactive sessions. The column is nullable, so every
-- existing session stays active; no row, column, index or constraint is altered
-- and nothing is erased. The creation-identity unique index deliberately keeps
-- covering removed rows so an old creation key can never recreate a removed story.
ALTER TABLE "interactive_sessions" ADD COLUMN "removed_at" TIMESTAMP(3);
