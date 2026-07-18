-- Phase G1 — fenced user-initiated generation cancellation.
--
-- Adds a `cancelled` GenerationRun terminal status (distinct from `failed`),
-- a `cancelled_at` timestamp recording when GenerationRunCoordinator.
-- cancelGeneration's fenced transition applied, and a precise CreditReason
-- for the compensating refund a cancellation of a billed run issues
-- (deliberately distinct from `refund_generation_failure`, since a voluntary
-- cancellation is not a pipeline failure).
--
-- No change to the existing `generation_runs_one_active_per_book` partial
-- unique index (WHERE status IN ('queued', 'running')) — `cancelled` was
-- never in that list, so a cancelled run is already correctly treated as
-- terminal/inactive by that index without any migration to it.

-- AlterEnum
ALTER TYPE "GenerationRunStatus" ADD VALUE 'cancelled';

-- AlterEnum
ALTER TYPE "CreditReason" ADD VALUE 'refund_generation_cancelled';

-- AlterTable
ALTER TABLE "generation_runs" ADD COLUMN     "cancelled_at" TIMESTAMP(3);
