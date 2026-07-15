import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentStep,
  GenerationRunStatus,
  type Prisma,
  type Book,
  type GenerationRun,
} from '@prisma/client';
import { PrismaService } from '../../src/database/prisma.service';
import { GenerationRunService } from '../../src/agent/generation-run.service';
import {
  GenerationExecutionService,
  StaleGenerationRunError,
} from '../../src/agent/generation-execution.service';
import { GenerationRunRecoveryService } from '../../src/agent/generation-run-recovery.service';
import { GenerationRunCoordinator } from '../../src/agent/generation-run-coordinator.service';
import type { GenerationOutcome } from '../../src/agent/generation-outcome';
import { GenerationInputSnapshotBackfillService } from '../../src/agent/generation-input-snapshot-backfill.service';
import { LocalImageAssetStorage } from '../../src/images/image-asset-storage';
import {
  buildInputSnapshot,
  hashInputSnapshot,
  parseGenerationInputSnapshot,
} from '../../src/agent/generation-input-snapshot';

/**
 * Durable integration coverage against a real Postgres (see
 * vitest.integration.config.ts) — not mocks. Proves the invariants that
 * depend on Postgres's actual row-locking/READ-COMMITTED re-check semantics,
 * which a mocked PrismaClient cannot verify: fenced claims/writes correctly
 * serialize concurrent attempts, atomic transactions leave no partial state,
 * and JSONB round-tripping preserves an input snapshot exactly.
 *
 * Every row created here is deleted in afterEach/afterAll — safe to run
 * against a shared local dev database.
 */
describe('Generation pipeline fencing (real Postgres)', () => {
  const prisma = new PrismaService();
  const userIds: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    // Deleting the user cascades to books -> generationRuns/outboxEvents.
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      userIds.length = 0;
    }
  });

  async function createUserAndBook(overrides: Partial<Book> = {}): Promise<Book> {
    const user = await prisma.user.create({
      data: { email: `integration-${randomUUID()}@example.test` },
    });
    userIds.push(user.id);
    return prisma.book.create({
      data: {
        userId: user.id,
        status: 'char_build',
        childName: 'Mia',
        childAge: 5,
        language: 'en',
        theme: 'friendship',
        pageCount: 6,
        ...overrides,
      },
    });
  }

  async function createRun(
    book: Book,
    overrides: Partial<GenerationRun> = {},
  ): Promise<GenerationRun> {
    const snapshot = buildInputSnapshot(book);
    const run = await prisma.generationRun.create({
      data: {
        bookId: book.id,
        userId: book.userId,
        kind: 'initial',
        status: GenerationRunStatus.running,
        inputSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        inputHash: hashInputSnapshot(snapshot),
        leaseOwner: 'worker-a',
        deliveryToken: 'delivery-token-a',
        fencingVersion: 1,
        ...(overrides as Prisma.GenerationRunUncheckedCreateInput),
      },
    });
    await prisma.book.update({ where: { id: book.id }, data: { activeRunId: run.id } });
    return run;
  }

  describe('GenerationRunService.claim', () => {
    it('lets the same worker re-claim its own still-live lease (a BullMQ retry re-invoking the same process)', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book);
      const service = new GenerationRunService(prisma);

      const claimed = await service.claim(run.id, 'token-2', 'worker-a', 60_000);

      expect(claimed).not.toBeNull();
      expect(claimed?.fencingVersion).toBe(run.fencingVersion + 1);
      expect(claimed?.deliveryToken).toBe('token-2');
    });

    it('a stalled-job redelivery to a different worker reclaims even though its BullMQ attempt count is unchanged and the old lease has not wall-clock-expired, then fences out the original (now-stale) delivery token', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { leaseExpiresAt: new Date(Date.now() + 60_000) });
      const service = new GenerationRunService(prisma);

      // worker-b receives a BullMQ stalled-job redelivery of the exact same
      // job — attemptsMade is unchanged, only the lock token is new — before
      // worker-a's lease has wall-clock-expired.
      const reclaimed = await service.claim(run.id, 'token-b', 'worker-b', 60_000);
      expect(reclaimed).not.toBeNull();
      expect(reclaimed?.leaseOwner).toBe('worker-b');
      expect(reclaimed?.deliveryToken).toBe('token-b');

      // worker-a's later write, still carrying the pre-redelivery
      // fencingVersion/deliveryToken it originally observed, must now be
      // rejected — proven here via heartbeat (see also the
      // applyFencedBookWrite fencing test below).
      const staleHeartbeat = await service.heartbeat(
        run.id,
        'delivery-token-a',
        run.fencingVersion,
        60_000,
      );
      expect(staleHeartbeat).toBe(false);
    });

    it('is a no-op for an already-terminal run', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { status: GenerationRunStatus.completed });
      const service = new GenerationRunService(prisma);

      const claimed = await service.claim(run.id, 'token-2', 'worker-a', 60_000);

      expect(claimed).toBeNull();
    });
  });

  describe('GenerationRunService.heartbeat', () => {
    it('extends the lease when deliveryToken and fencingVersion still match', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book);
      const service = new GenerationRunService(prisma);

      const result = await service.heartbeat(
        run.id,
        'delivery-token-a',
        run.fencingVersion,
        60_000,
      );

      expect(result).toBe(true);
      const reloaded = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloaded.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('rejects a heartbeat carrying a stale deliveryToken even if it happens to guess the current fencingVersion', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book);
      const service = new GenerationRunService(prisma);

      const result = await service.heartbeat(
        run.id,
        'some-other-token',
        run.fencingVersion,
        60_000,
      );

      expect(result).toBe(false);
    });
  });

  describe('GenerationExecutionService.applyFencedBookWrite', () => {
    it('atomically writes Book and bumps GenerationRun.currentStep when the fencingVersion still matches', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { fencingVersion: 5 });
      const execService = new GenerationExecutionService(prisma);
      const ctx = {
        runId: run.id,
        bookId: book.id,
        fencingVersion: 5,
        inputHash: run.inputHash,
        inputSnapshot: buildInputSnapshot(book),
      };

      const updated = await execService.applyFencedBookWrite(
        ctx,
        { title: 'New Title' },
        AgentStep.layout,
      );

      expect(updated.title).toBe('New Title');
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.currentStep).toBe(AgentStep.layout);
    });

    it('rejects a write from a stale fencingVersion and leaves Book provably untouched', async () => {
      const book = await createUserAndBook({ title: 'Original Title' });
      const run = await createRun(book, { fencingVersion: 5 });
      const execService = new GenerationExecutionService(prisma);
      const staleCtx = {
        runId: run.id,
        bookId: book.id,
        fencingVersion: 4, // a superseded attempt's observed version
        inputHash: run.inputHash,
        inputSnapshot: buildInputSnapshot(book),
      };

      await expect(
        execService.applyFencedBookWrite(staleCtx, { title: 'Stale Write' }, AgentStep.layout),
      ).rejects.toBeInstanceOf(StaleGenerationRunError);

      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.title).toBe('Original Title');
    });

    it('a claim that bumps fencingVersion fences out a write built from the pre-claim context', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, {
        fencingVersion: 1,
        leaseOwner: 'worker-a',
        deliveryToken: 'delivery-token-a',
      });
      const runService = new GenerationRunService(prisma);
      const execService = new GenerationExecutionService(prisma);
      const staleCtx = {
        runId: run.id,
        bookId: book.id,
        fencingVersion: run.fencingVersion,
        inputHash: run.inputHash,
        inputSnapshot: buildInputSnapshot(book),
      };

      // A newer delivery reclaims the run, bumping fencingVersion.
      const reclaimed = await runService.claim(run.id, 'token-b', 'worker-b', 60_000);
      expect(reclaimed?.fencingVersion).toBe(2);

      // The stale worker's in-flight write, built from the context it observed at its own claim time, must now fail.
      await expect(
        execService.applyFencedBookWrite(
          staleCtx,
          { title: 'From stale worker' },
          AgentStep.layout,
        ),
      ).rejects.toBeInstanceOf(StaleGenerationRunError);
    });
  });

  describe('Atomic terminal transition (GenerationRunCoordinator.completeRun — the actual production method)', () => {
    const coordinator = new GenerationRunCoordinator(prisma);

    function completedOutcome(overrides: Partial<GenerationOutcome> = {}): GenerationOutcome {
      return {
        status: 'complete' as GenerationOutcome['status'],
        completedStep: 'pdf_render' as GenerationOutcome['completedStep'],
        bookUpdate: { previewPdfUrl: '/files/books/b-1/storybook.pdf' },
        ...overrides,
      };
    }

    function failedOutcome(overrides: Partial<GenerationOutcome> = {}): GenerationOutcome {
      return {
        status: 'failed' as GenerationOutcome['status'],
        completedStep: 'pdf_render' as GenerationOutcome['completedStep'],
        errorCode: 'GENERATION_FAILED',
        errorMessage: 'boom',
        failedStep: 'pdf_render' as GenerationOutcome['failedStep'],
        bookUpdate: {},
        ...overrides,
      };
    }

    it('leaves Book and GenerationRun completely untouched when the fencing guard fails inside the transaction', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { fencingVersion: 3 });

      const published = await coordinator.completeRun(
        {
          runId: run.id,
          bookId: book.id,
          fencingVersion: 999,
          inputHash: run.inputHash,
          inputSnapshot: buildInputSnapshot(book),
        },
        completedOutcome(),
      );

      expect(published).toBe(false);
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.activeRunId).toBe(run.id); // unchanged
      expect(reloadedBook.publishedRunId).toBeNull();
      expect(reloadedBook.status).not.toBe('complete');
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.status).toBe(GenerationRunStatus.running);
    });

    it('atomically publishes Book.status=complete, GenerationRun.status=completed, activeRunId, and publishedRunId together on success', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { fencingVersion: 3 });

      const published = await coordinator.completeRun(
        {
          runId: run.id,
          bookId: book.id,
          fencingVersion: 3,
          inputHash: run.inputHash,
          inputSnapshot: buildInputSnapshot(book),
        },
        completedOutcome(),
      );

      expect(published).toBe(true);
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.activeRunId).toBeNull();
      expect(reloadedBook.publishedRunId).toBe(run.id);
      expect(reloadedBook.status).toBe('complete');
      expect(reloadedBook.previewPdfUrl).toBe('/files/books/b-1/storybook.pdf');
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.status).toBe(GenerationRunStatus.completed);
    });

    it('atomically publishes Book.status=failed with errorMessage/failedStep alongside GenerationRun.status=failed', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { fencingVersion: 1 });

      const published = await coordinator.completeRun(
        {
          runId: run.id,
          bookId: book.id,
          fencingVersion: 1,
          inputHash: run.inputHash,
          inputSnapshot: buildInputSnapshot(book),
        },
        failedOutcome({ errorMessage: 'PDF render crashed' }),
      );

      expect(published).toBe(true);
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.status).toBe('failed');
      expect(reloadedBook.errorMessage).toBe('PDF render crashed');
      expect(reloadedBook.failedStep).toBe('pdf_render');
      expect(reloadedBook.activeRunId).toBeNull();
      expect(reloadedBook.publishedRunId).toBeNull(); // never set on failure
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.status).toBe(GenerationRunStatus.failed);
      expect(reloadedRun.errorMessage).toBe('PDF render crashed');
    });

    it('failInvalidSnapshot atomically fails Book and GenerationRun with the stable GENERATION_INPUT_SNAPSHOT_INVALID code', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { fencingVersion: 2 });

      const published = await coordinator.failInvalidSnapshot(
        { runId: run.id, bookId: book.id, fencingVersion: 2 },
        'safe public message',
      );

      expect(published).toBe(true);
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.status).toBe('failed');
      expect(reloadedBook.errorMessage).toBe('safe public message');
      expect(reloadedBook.activeRunId).toBeNull();
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.status).toBe(GenerationRunStatus.failed);
      expect(reloadedRun.errorCode).toBe('GENERATION_INPUT_SNAPSHOT_INVALID');
    });

    it('failInvalidSnapshot is a no-op when the fencing guard finds the run already superseded', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { fencingVersion: 2 });

      const published = await coordinator.failInvalidSnapshot(
        { runId: run.id, bookId: book.id, fencingVersion: 999 },
        'safe public message',
      );

      expect(published).toBe(false);
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.status).toBe(GenerationRunStatus.running);
    });

    it("genuinely concurrent completeRun calls racing on the exact same fencingVersion (fired together via Promise.all — real overlapping transactions, not sequenced by the test) let exactly one win, via Postgres's own row-lock + WHERE re-check, not application-level ordering", async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { fencingVersion: 4 });
      const ctxA = {
        runId: run.id,
        bookId: book.id,
        fencingVersion: 4,
        inputHash: run.inputHash,
        inputSnapshot: buildInputSnapshot(book),
      };
      const ctxB = { ...ctxA };

      // Both calls observe the identical, currently-valid fencingVersion and
      // are dispatched together — genuinely concurrent from Node's
      // perspective, each on its own pooled connection — rather than
      // sequenced one after the other. Whichever transaction's UPDATE
      // commits first flips GenerationRun to `completed`; the other's WHERE
      // `status: running` then no longer matches, however narrowly it loses
      // the race, because Postgres re-evaluates the WHERE clause against the
      // row's actual current state at execution time, not a stale snapshot.
      const [resultA, resultB] = await Promise.all([
        coordinator.completeRun(
          ctxA,
          completedOutcome({ bookUpdate: { title: 'From attempt A' } }),
        ),
        coordinator.completeRun(
          ctxB,
          completedOutcome({ bookUpdate: { title: 'From attempt B' } }),
        ),
      ]);

      expect([resultA, resultB].filter(Boolean)).toHaveLength(1);

      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedBook.status).toBe('complete');
      expect(['From attempt A', 'From attempt B']).toContain(reloadedBook.title);
      expect(reloadedRun.status).toBe(GenerationRunStatus.completed);
    });
  });

  describe('GenerationRunRecoveryService — RecoveryLease leadership across two instances (deterministic, barrier-driven — no Promise-timing races)', () => {
    /**
     * acquireLease/stillHoldsLease are private — accessed directly here (not
     * through the public recover() entry point) so each step below can be
     * awaited and asserted on in a fixed, deterministic order instead of
     * firing two real concurrent recover() calls and hoping their
     * interleaving comes out a particular way (see the Promise.all version
     * this replaced). This is what "barrier-driven" means in practice: every
     * transition — A acquires, the lease is force-expired, B acquires — is
     * an explicit, awaited step, not a race.
     */
    type LeaseInternals = {
      acquireLease(leaseMs: number): Promise<number | null>;
      stillHoldsLease(generation: number): Promise<boolean>;
    };

    let prismaA: PrismaService;
    let prismaB: PrismaService;

    beforeEach(async () => {
      prismaA = new PrismaService();
      prismaB = new PrismaService();
      await prismaA.$connect();
      await prismaB.$connect();
      // Every test in this describe block starts from a clean, available lease.
      await prisma.recoveryLease.update({
        where: { id: 'generation_run_recovery' },
        data: { leaseOwner: null, leaseExpiresAt: null },
      });
    });

    afterEach(async () => {
      await prismaA.$disconnect();
      await prismaB.$disconnect();
    });

    it('a second instance cannot acquire while the first still holds a live (non-expired) lease', async () => {
      const neverPendingQueue = { isJobStillPending: async () => false } as never;
      const serviceA = new GenerationRunRecoveryService(
        prismaA,
        neverPendingQueue,
      ) as unknown as LeaseInternals;
      const serviceB = new GenerationRunRecoveryService(
        prismaB,
        neverPendingQueue,
      ) as unknown as LeaseInternals;

      const generationA = await serviceA.acquireLease(60_000);
      expect(generationA).not.toBeNull();

      const generationB = await serviceB.acquireLease(60_000);

      expect(generationB).toBeNull();
    });

    it("a new instance acquires once the lease has expired, monotonically bumping the fencing generation — and the former leader's stale generation is no longer valid", async () => {
      const neverPendingQueue = { isJobStillPending: async () => false } as never;
      const serviceA = new GenerationRunRecoveryService(
        prismaA,
        neverPendingQueue,
      ) as unknown as LeaseInternals;
      const serviceB = new GenerationRunRecoveryService(
        prismaB,
        neverPendingQueue,
      ) as unknown as LeaseInternals;

      const generationA = await serviceA.acquireLease(60_000);
      expect(generationA).not.toBeNull();
      expect(await serviceA.stillHoldsLease(generationA!)).toBe(true);

      // Deterministically force the lease to look expired — using
      // PostgreSQL's own server time, matching how acquireLease itself
      // compares expiry — rather than waiting out a real TTL.
      await prisma.$executeRaw`
        UPDATE recovery_leases SET lease_expires_at = NOW() - interval '1 second'
        WHERE id = 'generation_run_recovery'
      `;

      const generationB = await serviceB.acquireLease(60_000);

      expect(generationB).toBe(generationA! + 1);
      // (d)/(e)-equivalent for recovery leadership: the former leader's
      // generation-fenced check now fails — it must never continue issuing
      // recovery writes, even though its own in-process wall-clock check
      // hasn't necessarily caught up yet.
      expect(await serviceA.stillHoldsLease(generationA!)).toBe(false);
      expect(await serviceB.stillHoldsLease(generationB!)).toBe(true);
    });
  });

  describe('GenerationInputSnapshot JSONB round-trip fidelity', () => {
    it('preserves the exact prior input (including a nested childPhoto identity) through real Postgres storage — the basis for retry-after-edit correctness', async () => {
      const book = await createUserAndBook({
        childPhotoAssetKey: 'b-1/child-photo-v1',
        childPhotoContentType: 'image/jpeg',
        childPhotoSha256: 'a'.repeat(64),
        childPhotoSizeBytes: 1024,
      });
      const snapshot = buildInputSnapshot(book);
      const run = await prisma.generationRun.create({
        data: {
          bookId: book.id,
          userId: book.userId,
          kind: 'initial',
          inputSnapshot: snapshot as unknown as Prisma.InputJsonValue,
          inputHash: hashInputSnapshot(snapshot),
        },
      });

      // Simulate an edit to the book's live fields after the run was created —
      // retryGeneration must still resolve to the frozen snapshot, not this.
      await prisma.book.update({
        where: { id: book.id },
        data: { theme: 'edited-after-snapshot' },
      });

      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      const parsed = parseGenerationInputSnapshot(reloadedRun.id, reloadedRun.inputSnapshot);

      expect(parsed).toEqual(snapshot);
      expect(parsed.theme).toBe('friendship'); // not the post-edit 'edited-after-snapshot'
      expect(parsed.childPhoto).toEqual({
        assetKey: 'b-1/child-photo-v1',
        sha256: 'a'.repeat(64),
        contentType: 'image/jpeg',
        sizeBytes: 1024,
      });
    });

    it('a child-photo re-upload produces a distinct snapshot/hash even with identical other fields', async () => {
      const bookV1 = await createUserAndBook({
        childPhotoAssetKey: 'b-1/child-photo-v1',
        childPhotoContentType: 'image/jpeg',
        childPhotoSha256: 'a'.repeat(64),
        childPhotoSizeBytes: 1024,
      });
      const snapshotV1 = buildInputSnapshot(bookV1);

      // Re-upload: a new versioned key/digest, everything else identical.
      const bookV2 = await prisma.book.update({
        where: { id: bookV1.id },
        data: {
          childPhotoAssetKey: 'b-1/child-photo-v2',
          childPhotoSha256: 'b'.repeat(64),
        },
      });
      const snapshotV2 = buildInputSnapshot(bookV2);

      expect(hashInputSnapshot(snapshotV1)).not.toBe(hashInputSnapshot(snapshotV2));
    });
  });

  describe('GenerationInputSnapshotBackfillService — legacy pre-Phase-A snapshot migration', () => {
    const backfill = new GenerationInputSnapshotBackfillService(
      prisma,
      new LocalImageAssetStorage(),
    );

    /** The exact pre-Phase-A GenerationRun.input_snapshot JSON shape — no snapshotVersion, a bare childPhotoAssetKey/childPhotoContentType rather than childPhoto's full versioned identity object (predates Book.childPhotoSha256/childPhotoSizeBytes existing at all). */
    function preExistingPhaseASnapshotFixture(overrides: Record<string, unknown> = {}) {
      return {
        childName: 'Mia',
        childAge: 5,
        language: 'en',
        theme: 'friendship',
        educationalMessage: null,
        pageCount: 6,
        childPhotoAssetKey: null,
        childPhotoContentType: null,
        ...overrides,
      };
    }

    it('migrates a legacy run with no photo in place and persists the migrated snapshot back to the row', async () => {
      const book = await createUserAndBook();
      const run = await prisma.generationRun.create({
        data: {
          bookId: book.id,
          userId: book.userId,
          kind: 'initial',
          status: GenerationRunStatus.queued,
          inputSnapshot: preExistingPhaseASnapshotFixture() as unknown as Prisma.InputJsonValue,
          inputHash: 'legacy-hash',
        },
      });

      const migrated = await backfill.normalize(run);

      expect(migrated.snapshotVersion).toBe(2);
      expect(migrated.childPhoto).toBeNull();
      const reloaded = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloaded.inputSnapshot).toEqual(migrated);
      // Deployment safety: the migration only ever touches inputSnapshot —
      // status/fencing are provably untouched by it.
      expect(reloaded.status).toBe(GenerationRunStatus.queued);
    });

    it('migrates a legacy run with a photo: reads the real bytes from LocalImageAssetStorage, mints a fresh versioned copy, and never touches the original key', async () => {
      const storage = new LocalImageAssetStorage();
      const originalKey = `backfill-fixture-${randomUUID()}/child-photo-legacy`;
      const bytes = Buffer.from('real legacy photo bytes for backfill integration test');
      await storage.saveImageAsset(originalKey, bytes, 'image/jpeg');
      const localBackfill = new GenerationInputSnapshotBackfillService(prisma, storage);

      const book = await createUserAndBook();
      const run = await prisma.generationRun.create({
        data: {
          bookId: book.id,
          userId: book.userId,
          kind: 'initial',
          status: GenerationRunStatus.failed,
          failedAt: new Date(),
          inputSnapshot: preExistingPhaseASnapshotFixture({
            childPhotoAssetKey: originalKey,
            childPhotoContentType: 'image/jpeg',
          }) as unknown as Prisma.InputJsonValue,
          inputHash: 'legacy-hash',
        },
      });

      const migrated = await localBackfill.normalize(run);

      expect(migrated.childPhoto).not.toBeNull();
      expect(migrated.childPhoto!.assetKey).not.toBe(originalKey);
      expect(migrated.childPhoto!.sizeBytes).toBe(bytes.length);
      // The original key's bytes are untouched — the migration mints a copy, never mutates in place.
      const originalStillThere = await storage.getImageAsset(originalKey);
      expect(originalStillThere).toEqual(bytes);
      const migratedBytes = await storage.getImageAsset(migrated.childPhoto!.assetKey);
      expect(migratedBytes).toEqual(bytes);
      // Deployment safety: a run already terminal (failed) is still migrated cleanly.
      const reloaded = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloaded.status).toBe(GenerationRunStatus.failed);
    });

    it('is a safe no-op re-migration: normalizing an already-current snapshot a second time makes no further DB write', async () => {
      const book = await createUserAndBook();
      const run = await prisma.generationRun.create({
        data: {
          bookId: book.id,
          userId: book.userId,
          kind: 'initial',
          status: GenerationRunStatus.completed,
          completedAt: new Date(),
          inputSnapshot: preExistingPhaseASnapshotFixture() as unknown as Prisma.InputJsonValue,
          inputHash: 'legacy-hash',
        },
      });

      const firstPass = await backfill.normalize(run);
      const reloadedAfterFirst = await prisma.generationRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      const secondPass = await backfill.normalize(reloadedAfterFirst);

      expect(secondPass).toEqual(firstPass);
    });
  });
});
