-- Phase C — Orphaned Claim-Artifact Cleanup: seeds a second row in the
-- existing recovery_leases table for ClaimArtifactCleanupService's own
-- leader election, under a dedicated id so it never contends with
-- GenerationRunRecoveryService's "generation_run_recovery" row. No schema
-- change — recovery_leases already supports an arbitrary number of rows
-- (its primary key is `id`, not a fixed singleton), this just seeds the
-- one this service's fixed CLEANUP_LEASE_ID contends over, the same way
-- the original "generation_run_recovery" row was seeded (see
-- 20260714180027_phase_a_input_fencing_recovery_lease), so there is no
-- first-ever-acquire race between independent instances trying to insert it.
INSERT INTO "recovery_leases" ("id", "lease_owner", "lease_expires_at", "lease_generation", "updated_at")
VALUES ('claim_artifact_cleanup', NULL, NULL, 0, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
