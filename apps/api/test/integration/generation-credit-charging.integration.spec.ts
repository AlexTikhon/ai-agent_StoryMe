import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { GenerationRunStatus, type Book, type Prisma } from '@prisma/client';
import { PrismaService } from '../../src/database/prisma.service';
import {
  CreditsService,
  INSUFFICIENT_CREDITS_CODE,
  generationChargeIdempotencyKey,
  generationRefundIdempotencyKey,
} from '../../src/credits/credits.service';
import { GenerationRunService } from '../../src/agent/generation-run.service';
import { GenerationRunCoordinator } from '../../src/agent/generation-run-coordinator.service';
import { GenerationInputSnapshotBackfillService } from '../../src/agent/generation-input-snapshot-backfill.service';
import type { GenerationOutcome } from '../../src/agent/generation-outcome';
import { buildInputSnapshot, hashInputSnapshot } from '../../src/agent/generation-input-snapshot';
import { RateLimiterService } from '../../src/rate-limit/rate-limiter.service';
import { BooksService } from '../../src/books/books.service';

/**
 * Durable integration coverage against a real Postgres (see
 * vitest.integration.config.ts) for Phase E2 — wiring Phase E1's atomic
 * credit primitive into the generation lifecycle. Exercises the actual
 * production code: BooksService.startGeneration/retryGeneration (which own
 * the scheduling-time charge, via CreditsService.deductInTransaction inside
 * createRunAndSchedule's single transaction) and
 * GenerationRunCoordinator.completeRun (which owns the failure-time refund,
 * via CreditsService.addInTransaction inside runFencedTerminalTransition's
 * single transaction) — not a hand-copied mirror of either.
 *
 * BooksService is constructed with real collaborators for everything the
 * scheduling transaction actually touches (Prisma, CreditsService,
 * GenerationRunService, GenerationRunCoordinator, GenerationInputSnapshot-
 * BackfillService, RateLimiterService) and inert stand-ins for the rest
 * (AgentService, PdfStorage, ImageAssetStorage, GenerationQueueService,
 * GenerationJobService, ChildPhotoProcessor) — none of these tests ever run
 * the generation pipeline itself, only scheduling and terminal-transition
 * bookkeeping, so the stand-ins are never invoked.
 */
describe('Generation credit charging and refunds (Phase E2, real Postgres)', () => {
  const prisma = new PrismaService();
  const creditsService = new CreditsService(prisma);
  const generationRunService = new GenerationRunService(prisma);
  const generationRunCoordinator = new GenerationRunCoordinator(prisma, creditsService);
  const snapshotBackfill = new GenerationInputSnapshotBackfillService(prisma, {} as never);
  const rateLimiter = new RateLimiterService();
  const generousConfig = {
    get: (_key: string) => 1_000_000,
  } as never;
  const booksService = new BooksService(
    prisma,
    {} as never, // AgentService — never invoked; these tests only cover scheduling/terminal transitions, not the pipeline itself
    {} as never, // PdfStorage
    {} as never, // ImageAssetStorage
    {} as never, // GenerationQueueService
    { createQueued: async () => undefined } as never, // GenerationJobService — best-effort legacy mirror, safe to no-op
    generationRunService,
    generationRunCoordinator,
    snapshotBackfill,
    generousConfig,
    rateLimiter,
    {} as never, // ChildPhotoProcessor
    creditsService,
  );

  const userIds: string[] = [];
  const runIdsForOutboxCleanup: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    if (runIdsForOutboxCleanup.length > 0) {
      await prisma.outboxEvent.deleteMany({
        where: { aggregateId: { in: runIdsForOutboxCleanup } },
      });
      runIdsForOutboxCleanup.length = 0;
    }
    if (userIds.length > 0) {
      // CreditTransaction.user has no onDelete: Cascade (an intentional
      // financial-audit-trail choice) — delete ledger rows before the user
      // row they reference. Book/GenerationRun/AgentLog do cascade from User.
      await prisma.creditTransaction.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      userIds.length = 0;
    }
  });

  async function createUserAndBook(credits: number, overrides: Partial<Book> = {}): Promise<Book> {
    const user = await prisma.user.create({
      data: { email: `credit-charging-${randomUUID()}@example.test`, credits },
    });
    userIds.push(user.id);
    return prisma.book.create({
      data: {
        userId: user.id,
        status: 'created',
        childName: 'Mia',
        childAge: 5,
        language: 'en',
        theme: 'friendship',
        pageCount: 6,
        ...overrides,
      },
    });
  }

  function failedOutcome(overrides: Partial<GenerationOutcome> = {}): GenerationOutcome {
    return {
      status: 'failed' as GenerationOutcome['status'],
      completedStep: 'pdf_render' as GenerationOutcome['completedStep'],
      errorCode: 'GENERATION_FAILED',
      errorMessage: 'boom',
      failedStep: 'pdf_render' as GenerationOutcome['failedStep'],
      bookUpdate: {},
      agentLogs: [],
      ...overrides,
    };
  }

  function completedOutcome(overrides: Partial<GenerationOutcome> = {}): GenerationOutcome {
    return {
      status: 'complete' as GenerationOutcome['status'],
      completedStep: 'pdf_render' as GenerationOutcome['completedStep'],
      bookUpdate: {},
      agentLogs: [],
      ...overrides,
    };
  }

  describe('Scheduling atomicity (BooksService.startGeneration/retryGeneration — the actual production methods)', () => {
    it('commits the GenerationRun, the Book transition, the OutboxEvent, and the debit together', async () => {
      const book = await createUserAndBook(3);

      const result = await booksService.startGeneration(book.userId, book.id);

      expect(result.book.status).toBe('char_build');
      const run = await prisma.generationRun.findFirstOrThrow({ where: { bookId: book.id } });
      runIdsForOutboxCleanup.push(run.id);

      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.activeRunId).toBe(run.id);

      const outbox = await prisma.outboxEvent.findFirst({ where: { aggregateId: run.id } });
      expect(outbox).not.toBeNull();

      const reloadedUser = await prisma.user.findUniqueOrThrow({ where: { id: book.userId } });
      expect(reloadedUser.credits).toBe(2);

      const charges = await prisma.creditTransaction.findMany({ where: { userId: book.userId } });
      expect(charges).toHaveLength(1);
      expect(charges[0]).toMatchObject({
        amount: -1,
        balanceAfter: 2,
        reason: 'book_creation',
        bookId: book.id,
        idempotencyKey: generationChargeIdempotencyKey(run.id),
      });
    });

    it('commits none of them (no run, no Book transition, no outbox, no ledger row) when the user has insufficient credits', async () => {
      const book = await createUserAndBook(0);
      const outboxCountBefore = await prisma.outboxEvent.count();

      await expect(booksService.startGeneration(book.userId, book.id)).rejects.toMatchObject({
        status: HttpStatus.PAYMENT_REQUIRED,
        response: expect.objectContaining({ code: INSUFFICIENT_CREDITS_CODE }),
      });

      const runs = await prisma.generationRun.findMany({ where: { bookId: book.id } });
      expect(runs).toHaveLength(0);
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.status).toBe('created');
      expect(reloadedBook.activeRunId).toBeNull();
      expect(await prisma.outboxEvent.count()).toBe(outboxCountBefore);
      const reloadedUser = await prisma.user.findUniqueOrThrow({ where: { id: book.userId } });
      expect(reloadedUser.credits).toBe(0);
      const ledger = await prisma.creditTransaction.findMany({ where: { userId: book.userId } });
      expect(ledger).toHaveLength(0);
    });

    it('a forced debit-ledger failure rolls back the entire scheduling transaction — the GenerationRun and Book transition included', async () => {
      // CreditsService.deductInTransaction is the exact method
      // createRunAndSchedule composes into its own transaction — the public
      // API never lets a caller supply an invalid bookId (it always passes
      // the just-created run's own book), so this forces the same ledger
      // FK-violation failure E1's own tests use, composed here alongside a
      // real GenerationRun create and Book update in one transaction, to
      // prove the composition — not just CreditsService alone — rolls back
      // as a unit.
      const book = await createUserAndBook(5);
      const noSuchBookId = randomUUID();

      await expect(
        prisma.$transaction(async (tx) => {
          const snapshot = buildInputSnapshot(book);
          const run = await tx.generationRun.create({
            data: {
              bookId: book.id,
              userId: book.userId,
              kind: 'initial',
              inputSnapshot: snapshot as unknown as Prisma.InputJsonValue,
              inputHash: hashInputSnapshot(snapshot),
            },
          });
          await creditsService.deductInTransaction(tx, {
            userId: book.userId,
            amount: 1,
            reason: 'book_creation',
            bookId: noSuchBookId,
            idempotencyKey: generationChargeIdempotencyKey(run.id),
          });
          await tx.book.update({
            where: { id: book.id, status: 'created' },
            data: { status: 'char_build', activeRunId: run.id },
          });
        }),
      ).rejects.toThrow();

      const runs = await prisma.generationRun.findMany({ where: { bookId: book.id } });
      expect(runs).toHaveLength(0);
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.status).toBe('created');
      expect(reloadedBook.activeRunId).toBeNull();
      const reloadedUser = await prisma.user.findUniqueOrThrow({ where: { id: book.userId } });
      expect(reloadedUser.credits).toBe(5);
      const ledger = await prisma.creditTransaction.findMany({ where: { userId: book.userId } });
      expect(ledger).toHaveLength(0);
    });

    it('two concurrent starts against a one-credit balance produce exactly one scheduled run and exactly one debit', async () => {
      const book = await createUserAndBook(1);

      const [a, b] = await Promise.allSettled([
        booksService.startGeneration(book.userId, book.id),
        booksService.startGeneration(book.userId, book.id),
      ]);

      const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
      const rejected = [a, b].filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const runs = await prisma.generationRun.findMany({ where: { bookId: book.id } });
      expect(runs).toHaveLength(1);
      runIdsForOutboxCleanup.push(...runs.map((r) => r.id));

      const debits = await prisma.creditTransaction.findMany({
        where: { userId: book.userId, amount: { lt: 0 } },
      });
      expect(debits).toHaveLength(1);
      const reloadedUser = await prisma.user.findUniqueOrThrow({ where: { id: book.userId } });
      expect(reloadedUser.credits).toBe(0);
    });
  });

  describe('Refund atomicity (GenerationRunCoordinator.completeRun — the actual production method)', () => {
    it('an accepted successful completion leaves the balance reduced (no refund)', async () => {
      const book = await createUserAndBook(3);
      await booksService.startGeneration(book.userId, book.id);
      const run = await prisma.generationRun.findFirstOrThrow({ where: { bookId: book.id } });
      runIdsForOutboxCleanup.push(run.id);
      const claimed = await generationRunService.claim(run.id, 'token-1', 'worker-1', 60_000);

      const result = await generationRunCoordinator.completeRun(
        { runId: run.id, bookId: book.id, fencingVersion: claimed!.fencingVersion },
        completedOutcome(),
      );

      expect(result).toBe('applied');
      const reloadedUser = await prisma.user.findUniqueOrThrow({ where: { id: book.userId } });
      expect(reloadedUser.credits).toBe(2);
      const ledger = await prisma.creditTransaction.findMany({ where: { userId: book.userId } });
      expect(ledger).toHaveLength(1); // the charge only — no refund
    });

    it('an accepted failure restores the balance and creates exactly one compensating ledger row', async () => {
      const book = await createUserAndBook(3);
      await booksService.startGeneration(book.userId, book.id);
      const run = await prisma.generationRun.findFirstOrThrow({ where: { bookId: book.id } });
      runIdsForOutboxCleanup.push(run.id);
      const claimed = await generationRunService.claim(run.id, 'token-1', 'worker-1', 60_000);

      const result = await generationRunCoordinator.completeRun(
        { runId: run.id, bookId: book.id, fencingVersion: claimed!.fencingVersion },
        failedOutcome(),
      );

      expect(result).toBe('applied');
      const reloadedUser = await prisma.user.findUniqueOrThrow({ where: { id: book.userId } });
      expect(reloadedUser.credits).toBe(3); // fully restored
      const ledger = await prisma.creditTransaction.findMany({
        where: { userId: book.userId },
        orderBy: { createdAt: 'asc' },
      });
      expect(ledger).toHaveLength(2);
      expect(ledger[0]).toMatchObject({ amount: -1, reason: 'book_creation' });
      expect(ledger[1]).toMatchObject({
        amount: 1,
        reason: 'refund_generation_failure',
        idempotencyKey: generationRefundIdempotencyKey(run.id),
      });

      // Retrying the exact same terminalization (e.g. a redelivered/retried
      // caller) must never refund a second time — the run is no longer
      // `running`, so the fence itself rejects it before the refund lookup
      // ever runs.
      const retryResult = await generationRunCoordinator.completeRun(
        { runId: run.id, bookId: book.id, fencingVersion: claimed!.fencingVersion },
        failedOutcome(),
      );
      expect(retryResult).toBe('stale_fence');
      const userAfterRetry = await prisma.user.findUniqueOrThrow({ where: { id: book.userId } });
      expect(userAfterRetry.credits).toBe(3);
      const ledgerAfterRetry = await prisma.creditTransaction.findMany({
        where: { userId: book.userId },
      });
      expect(ledgerAfterRetry).toHaveLength(2);
    });

    it('a stale/superseded completion cannot refund', async () => {
      const book = await createUserAndBook(3);
      await booksService.startGeneration(book.userId, book.id);
      const run = await prisma.generationRun.findFirstOrThrow({ where: { bookId: book.id } });
      runIdsForOutboxCleanup.push(run.id);
      const staleClaim = await generationRunService.claim(run.id, 'token-a', 'worker-a', 60_000);
      // A newer delivery reclaims the run before worker-a's own attempt
      // finishes, bumping fencingVersion out from under it.
      await generationRunService.claim(run.id, 'token-b', 'worker-b', 60_000);

      const result = await generationRunCoordinator.completeRun(
        { runId: run.id, bookId: book.id, fencingVersion: staleClaim!.fencingVersion },
        failedOutcome(),
      );

      expect(result).toBe('stale_fence');
      const reloadedUser = await prisma.user.findUniqueOrThrow({ where: { id: book.userId } });
      expect(reloadedUser.credits).toBe(2); // still just the original charge — no refund
      const ledger = await prisma.creditTransaction.findMany({ where: { userId: book.userId } });
      expect(ledger).toHaveLength(1);
    });

    it('a forced refund-ledger failure rolls back GenerationRun, Book, AgentLog, and the balance change together', async () => {
      const book = await createUserAndBook(3);
      await booksService.startGeneration(book.userId, book.id);
      const run = await prisma.generationRun.findFirstOrThrow({ where: { bookId: book.id } });
      runIdsForOutboxCleanup.push(run.id);
      const claimed = await generationRunService.claim(run.id, 'token-1', 'worker-1', 60_000);

      // Pre-occupy the deterministic refund idempotency key this failure
      // would use, forcing the ledger insert inside the coordinator's own
      // refund step to hit the DB's unique constraint.
      await prisma.creditTransaction.create({
        data: {
          userId: book.userId,
          amount: 1,
          balanceAfter: 999,
          reason: 'refund_generation_failure',
          idempotencyKey: generationRefundIdempotencyKey(run.id),
        },
      });

      await expect(
        generationRunCoordinator.completeRun(
          { runId: run.id, bookId: book.id, fencingVersion: claimed!.fencingVersion },
          failedOutcome({
            agentLogs: [
              {
                bookId: book.id,
                agent: 'LocalPipelineAgent',
                step: 'pdf_render' as GenerationOutcome['completedStep'],
                status: 'success',
                attempt: 1,
                traceId: 'trace-refund-fail',
              },
            ],
          }),
        ),
      ).rejects.toThrow();

      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.status).toBe(GenerationRunStatus.running); // never reached 'failed'
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.status).not.toBe('failed');
      expect(reloadedBook.activeRunId).toBe(run.id);
      const logs = await prisma.agentLog.findMany({ where: { bookId: book.id } });
      expect(logs).toHaveLength(0);
      const reloadedUser = await prisma.user.findUniqueOrThrow({ where: { id: book.userId } });
      expect(reloadedUser.credits).toBe(2); // unchanged from the original charge
    });

    it('a pre-Phase-E2/legacy run with no matching charge is failed without receiving a free credit', async () => {
      const book = await createUserAndBook(3);
      const snapshot = buildInputSnapshot(book);
      // Bypasses BooksService.createRunAndSchedule entirely, mirroring a run
      // created before Phase E2 shipped — no CreditTransaction was ever
      // written for it.
      const run = await prisma.generationRun.create({
        data: {
          bookId: book.id,
          userId: book.userId,
          kind: 'initial',
          status: GenerationRunStatus.running,
          inputSnapshot: snapshot as unknown as Prisma.InputJsonValue,
          inputHash: hashInputSnapshot(snapshot),
          fencingVersion: 1,
        },
      });
      await prisma.book.update({ where: { id: book.id }, data: { activeRunId: run.id } });

      const result = await generationRunCoordinator.completeRun(
        { runId: run.id, bookId: book.id, fencingVersion: 1 },
        failedOutcome(),
      );

      expect(result).toBe('applied');
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.status).toBe(GenerationRunStatus.failed);
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.status).toBe('failed');
      const reloadedUser = await prisma.user.findUniqueOrThrow({ where: { id: book.userId } });
      expect(reloadedUser.credits).toBe(3); // no charge existed, so no refund was granted either
      const ledger = await prisma.creditTransaction.findMany({ where: { userId: book.userId } });
      expect(ledger).toHaveLength(0);
    });

    it('a retry after a refunded failure creates a distinct new charge/refund lifecycle', async () => {
      const book = await createUserAndBook(3);
      await booksService.startGeneration(book.userId, book.id);
      const firstRun = await prisma.generationRun.findFirstOrThrow({ where: { bookId: book.id } });
      runIdsForOutboxCleanup.push(firstRun.id);
      const claimed = await generationRunService.claim(firstRun.id, 'token-1', 'worker-1', 60_000);
      await generationRunCoordinator.completeRun(
        { runId: firstRun.id, bookId: book.id, fencingVersion: claimed!.fencingVersion },
        failedOutcome(),
      );
      // Balance is back to 3 after the refund.

      await booksService.retryGeneration(book.userId, book.id);
      const secondRun = await prisma.generationRun.findFirstOrThrow({
        where: { bookId: book.id, id: { not: firstRun.id } },
      });
      runIdsForOutboxCleanup.push(secondRun.id);

      expect(secondRun.id).not.toBe(firstRun.id);
      expect(secondRun.retryOfRunId).toBe(firstRun.id);
      const reloadedUser = await prisma.user.findUniqueOrThrow({ where: { id: book.userId } });
      expect(reloadedUser.credits).toBe(2); // charged again, independently of the first run's refunded charge

      const ledger = await prisma.creditTransaction.findMany({
        where: { userId: book.userId },
        orderBy: { createdAt: 'asc' },
      });
      expect(ledger).toHaveLength(3);
      expect(ledger.map((row) => row.idempotencyKey)).toEqual([
        generationChargeIdempotencyKey(firstRun.id),
        generationRefundIdempotencyKey(firstRun.id),
        generationChargeIdempotencyKey(secondRun.id),
      ]);
    });
  });
});
