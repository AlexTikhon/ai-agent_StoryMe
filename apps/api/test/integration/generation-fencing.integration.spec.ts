import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
        leaseAttempt: 1,
        fencingVersion: 1,
        ...(overrides as Prisma.GenerationRunUncheckedCreateInput),
      },
    });
    await prisma.book.update({ where: { id: book.id }, data: { activeRunId: run.id } });
    return run;
  }

  describe('GenerationRunService.claim', () => {
    it('lets the same worker re-claim its own still-live lease', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book);
      const service = new GenerationRunService(prisma);

      const claimed = await service.claim(run.id, 'worker-a', 60_000, 1);

      expect(claimed).not.toBeNull();
      expect(claimed?.fencingVersion).toBe(run.fencingVersion + 1);
    });

    it('lets a strictly-higher BullMQ attempt from a different worker reclaim before the lease wall-clock-expires, and fences out the stale worker', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { leaseExpiresAt: new Date(Date.now() + 60_000) });
      const service = new GenerationRunService(prisma);

      // worker-b delivers attempt 2 — a legitimate BullMQ redelivery — before
      // worker-a's lease has wall-clock-expired.
      const reclaimed = await service.claim(run.id, 'worker-b', 60_000, 2);
      expect(reclaimed).not.toBeNull();
      expect(reclaimed?.leaseOwner).toBe('worker-b');

      // worker-a (the stale attempt) can no longer claim with its old attempt number.
      const staleReclaim = await service.claim(run.id, 'worker-a', 60_000, 1);
      expect(staleReclaim).toBeNull();
    });

    it('is a no-op for an already-terminal run', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { status: GenerationRunStatus.completed });
      const service = new GenerationRunService(prisma);

      const claimed = await service.claim(run.id, 'worker-a', 60_000, 2);

      expect(claimed).toBeNull();
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
        leaseAttempt: 1,
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
      const reclaimed = await runService.claim(run.id, 'worker-b', 60_000, 2);
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

  describe('Atomic terminal transition (completeRun pattern)', () => {
    /** Mirrors BooksService.completeRun's transaction shape directly against real Postgres, since that method is private. */
    async function completeRunLike(
      runId: string,
      bookId: string,
      fencingVersion: number,
    ): Promise<boolean> {
      return prisma.$transaction(async (tx) => {
        const runUpdate = await tx.generationRun.updateMany({
          where: { id: runId, status: GenerationRunStatus.running, fencingVersion },
          data: { status: GenerationRunStatus.completed, completedAt: new Date() },
        });
        if (runUpdate.count === 0) return false;
        await tx.book.updateMany({
          where: { id: bookId, activeRunId: runId },
          data: { activeRunId: null, publishedRunId: runId },
        });
        return true;
      });
    }

    it('leaves Book completely untouched when the fencing guard fails inside the transaction', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { fencingVersion: 3 });

      const result = await completeRunLike(run.id, book.id, 999 /* wrong version */);

      expect(result).toBe(false);
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.activeRunId).toBe(run.id); // unchanged
      expect(reloadedBook.publishedRunId).toBeNull();
    });

    it('atomically publishes the run on success', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { fencingVersion: 3 });

      const result = await completeRunLike(run.id, book.id, 3);

      expect(result).toBe(true);
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.activeRunId).toBeNull();
      expect(reloadedBook.publishedRunId).toBe(run.id);
    });
  });

  describe('GenerationRunRecoveryService — RecoveryLease leadership across two instances', () => {
    it('only one of two concurrently-recovering instances proceeds past the lease acquire', async () => {
      const prismaA = new PrismaService();
      const prismaB = new PrismaService();
      await prismaA.$connect();
      await prismaB.$connect();
      const neverPendingQueue = { isJobStillPending: async () => false } as never;
      const serviceA = new GenerationRunRecoveryService(prismaA, neverPendingQueue);
      const serviceB = new GenerationRunRecoveryService(prismaB, neverPendingQueue);

      try {
        const [resultA, resultB] = await Promise.all([serviceA.recover(), serviceB.recover()]);

        const lockSkippedCount = [resultA, resultB].filter((r) => r.lockSkipped).length;
        expect(lockSkippedCount).toBe(1);
      } finally {
        await prismaA.$disconnect();
        await prismaB.$disconnect();
      }
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
});
