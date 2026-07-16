import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service';
import { ClaimArtifactCleanupService } from '../../src/agent/claim-artifact-cleanup.service';
import { GenerationRunRecoveryService } from '../../src/agent/generation-run-recovery.service';
import { GenerationRunCoordinator } from '../../src/agent/generation-run-coordinator.service';
import { LocalImageAssetStorage } from '../../src/images/image-asset-storage';
import { LocalPdfStorage } from '../../src/pdf/pdf-storage';

/**
 * Durable integration coverage against a real Postgres (see
 * vitest.integration.config.ts) — proves the Phase C claim-artifact-cleanup
 * lease (id "claim_artifact_cleanup", seeded by migration
 * 20260716000000_phase_c_claim_cleanup_lease) and the pre-existing
 * generation-run-recovery lease (id "generation_run_recovery") are genuinely
 * independent rows in `recovery_leases`: each service's leader election must
 * never observe, acquire, or overwrite the other's row, so the two sweeps can
 * run concurrently on the same or different instances without contending.
 *
 * acquireLease/stillHoldsLease/releaseLease are private on both services —
 * accessed directly here (not through the public sweep()/recover() entry
 * points), mirroring the barrier-driven pattern already used for
 * generation_run_recovery leadership in generation-fencing.integration.spec.ts,
 * so every transition is an explicit awaited step, not a timing-dependent race.
 */
describe('ClaimArtifactCleanupService / GenerationRunRecoveryService — independent RecoveryLease rows (real Postgres)', () => {
  type CleanupLeaseInternals = {
    acquireLease(leaseMs: number): Promise<number | null>;
    stillHoldsLease(generation: number): Promise<boolean>;
    releaseLease(generation: number): Promise<void>;
  };
  type RecoveryLeaseInternals = {
    acquireLease(leaseMs: number): Promise<number | null>;
    stillHoldsLease(generation: number): Promise<boolean>;
  };

  const prisma = new PrismaService();

  function newCleanupService(): CleanupLeaseInternals {
    return new ClaimArtifactCleanupService(
      prisma,
      new LocalImageAssetStorage(),
      new LocalPdfStorage(),
    ) as unknown as CleanupLeaseInternals;
  }

  function newRecoveryService(): RecoveryLeaseInternals {
    const neverPendingQueue = { isJobStillPending: async () => false } as never;
    return new GenerationRunRecoveryService(
      prisma,
      neverPendingQueue,
      new GenerationRunCoordinator(prisma),
    ) as unknown as RecoveryLeaseInternals;
  }

  beforeEach(async () => {
    // Every test starts from both leases clean/available, regardless of what
    // an earlier suite (or a live dev-mode API process) left behind.
    await prisma.recoveryLease.update({
      where: { id: 'generation_run_recovery' },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
    await prisma.recoveryLease.update({
      where: { id: 'claim_artifact_cleanup' },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
  });

  afterEach(async () => {
    await prisma.recoveryLease.update({
      where: { id: 'generation_run_recovery' },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
    await prisma.recoveryLease.update({
      where: { id: 'claim_artifact_cleanup' },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
  });

  it('seeds exactly one claim_artifact_cleanup row, distinct from generation_run_recovery', async () => {
    const rows = await prisma.recoveryLease.findMany({
      where: { id: { in: ['claim_artifact_cleanup', 'generation_run_recovery'] } },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(['claim_artifact_cleanup', 'generation_run_recovery']);
  });

  it('a live generation_run_recovery lease does not block claim_artifact_cleanup from acquiring, and vice versa', async () => {
    const recovery = newRecoveryService();
    const cleanup = newCleanupService();

    const recoveryGeneration = await recovery.acquireLease(60_000);
    expect(recoveryGeneration).not.toBeNull();

    const cleanupGeneration = await cleanup.acquireLease(60_000);
    expect(cleanupGeneration).not.toBeNull();

    // Both held simultaneously, each still valid under its own service.
    expect(await recovery.stillHoldsLease(recoveryGeneration!)).toBe(true);
    expect(await cleanup.stillHoldsLease(cleanupGeneration!)).toBe(true);
  });

  it('a second ClaimArtifactCleanupService instance cannot acquire while the first still holds a live claim_artifact_cleanup lease', async () => {
    const cleanupA = newCleanupService();
    const cleanupB = newCleanupService();

    const generationA = await cleanupA.acquireLease(60_000);
    expect(generationA).not.toBeNull();

    const generationB = await cleanupB.acquireLease(60_000);
    expect(generationB).toBeNull();
  });

  it('acquiring/releasing the claim_artifact_cleanup lease never mutates the generation_run_recovery row', async () => {
    const recovery = newRecoveryService();
    const cleanup = newCleanupService();

    const recoveryGeneration = await recovery.acquireLease(60_000);
    const recoveryRowBefore = await prisma.recoveryLease.findUniqueOrThrow({
      where: { id: 'generation_run_recovery' },
    });

    const cleanupGeneration = await cleanup.acquireLease(60_000);
    await cleanup.releaseLease(cleanupGeneration!);

    const recoveryRowAfter = await prisma.recoveryLease.findUniqueOrThrow({
      where: { id: 'generation_run_recovery' },
    });
    expect(recoveryRowAfter).toEqual(recoveryRowBefore);
    // The recovery lease itself is untouched/unaffected the entire time.
    expect(await recovery.stillHoldsLease(recoveryGeneration!)).toBe(true);
  });

  it("a new claim_artifact_cleanup owner acquires once expired, bumping its own fencing generation independently of generation_run_recovery's", async () => {
    const recovery = newRecoveryService();
    const cleanupA = newCleanupService();
    const cleanupB = newCleanupService();

    const recoveryGeneration = await recovery.acquireLease(60_000);
    expect(recoveryGeneration).not.toBeNull();

    const generationA = await cleanupA.acquireLease(60_000);
    expect(generationA).not.toBeNull();

    await prisma.$executeRaw`
      UPDATE recovery_leases SET lease_expires_at = NOW() - interval '1 second'
      WHERE id = 'claim_artifact_cleanup'
    `;

    const generationB = await cleanupB.acquireLease(60_000);
    expect(generationB).toBe(generationA! + 1);
    expect(await cleanupA.stillHoldsLease(generationA!)).toBe(false);
    expect(await cleanupB.stillHoldsLease(generationB!)).toBe(true);

    // Force-expiring the cleanup lease must never have touched the
    // recovery lease's own row/generation.
    expect(await recovery.stillHoldsLease(recoveryGeneration!)).toBe(true);
  });
});
