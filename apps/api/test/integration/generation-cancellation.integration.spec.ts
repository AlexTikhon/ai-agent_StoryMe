import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GenerationRunStatus, type Book, type GenerationRun, type Prisma } from '@prisma/client';
import { PrismaService } from '../../src/database/prisma.service';
import { GenerationRunService } from '../../src/agent/generation-run.service';
import { GenerationRunCoordinator } from '../../src/agent/generation-run-coordinator.service';
import { GenerationRunRecoveryService } from '../../src/agent/generation-run-recovery.service';
import {
  CreditsService,
  generationCancellationRefundIdempotencyKey,
  generationChargeIdempotencyKey,
} from '../../src/credits/credits.service';
import { OutboxService, OUTBOX_STATUS_DISPATCHED } from '../../src/outbox/outbox.service';
import { OutboxDispatcherService } from '../../src/outbox/outbox-dispatcher.service';
import { buildInputSnapshot, hashInputSnapshot } from '../../src/agent/generation-input-snapshot';
import type { GenerationOutcome } from '../../src/agent/generation-outcome';

/**
 * Durable integration coverage against a real Postgres (see
 * vitest.integration.config.ts) for Phase G1 — fenced user-initiated
 * generation cancellation. Exercises the actual production transaction
 * (GenerationRunCoordinator.cancelGeneration), not a hand-copied mirror of
 * it, the same way generation-credit-charging.integration.spec.ts exercises
 * completeRun.
 *
 * A note on "book_mirror_mismatch" coverage: unlike completeRun/
 * failAbandoned/failInvalidSnapshot (which all fence a *pre-resolved*
 * ClaimedRunRef the caller already trusts), cancelGeneration derives the run
 * it targets from a fresh read of Book.activeRunId inside its own
 * transaction. That makes the mismatch condition (run fence holds, but
 * Book.activeRunId has since drifted) structurally impossible to force here
 * by pre-corrupting Book.activeRunId before the call — cancelGeneration
 * would simply see the corrupted state as its very first read and report
 * 'not_in_progress'/'already_cancelled', never reaching the run fence at
 * all. A real mismatch would require an actual concurrent mutation landing
 * inside the narrow window between cancelGeneration's own Book read and its
 * later Book write — not reproducible without either a sleep-based race
 * (forbidden) or a test-only hook into production code. This invariant IS
 * proven deterministically at the unit level (generation-run-coordinator
 * .service.spec.ts, "cancelGeneration (Phase G1)" — forces the exact
 * `updateMany` count:0 condition and asserts the transaction rolls back
 * before any refund/outbox write). This file instead proves the identical
 * *rollback mechanism* — "any failure after the run fence undoes everything
 * committed so far in the same transaction" — via a scenario that genuinely
 * is forceable against real Postgres: a forced refund-ledger conflict (see
 * "Refund insert failure" below).
 */
describe('Generation cancellation (Phase G1, real Postgres)', () => {
  const prisma = new PrismaService();
  const creditsService = new CreditsService(prisma);
  const generationRunService = new GenerationRunService(prisma);
  const coordinator = new GenerationRunCoordinator(prisma, creditsService);
  const outboxService = new OutboxService(prisma);

  const userIds: string[] = [];
  const runIdsForOutboxCleanup: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    // OutboxEvent has no FK relation to GenerationRun (aggregateId is a
    // plain field, not a foreign key — see OutboxEvent's own schema
    // comment), so it never cascades from the User/Book/GenerationRun
    // deletes below and must be cleaned up explicitly.
    if (runIdsForOutboxCleanup.length > 0) {
      await prisma.outboxEvent.deleteMany({
        where: { aggregateId: { in: runIdsForOutboxCleanup } },
      });
      runIdsForOutboxCleanup.length = 0;
    }
    if (userIds.length > 0) {
      // CreditTransaction.user has no onDelete: Cascade (financial-audit-
      // trail choice) — delete ledger rows before the user row they
      // reference. Book/GenerationRun/AgentLog cascade from User -> Book ->
      // GenerationRun.
      await prisma.creditTransaction.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      userIds.length = 0;
    }
  });

  async function createUserAndBook(credits: number, overrides: Partial<Book> = {}): Promise<Book> {
    const user = await prisma.user.create({
      data: { email: `cancellation-${randomUUID()}@example.test`, credits },
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

  /** Creates a GenerationRun the way BooksService.createRunAndSchedule would — including its charge CreditTransaction and pending OutboxEvent — unless `charged: false` is passed. */
  async function createRun(
    book: Book,
    overrides: Partial<GenerationRun> & { charged?: boolean } = {},
  ): Promise<GenerationRun> {
    const { charged = true, ...runOverrides } = overrides;
    const snapshot = buildInputSnapshot(book);
    const run = await prisma.generationRun.create({
      data: {
        bookId: book.id,
        userId: book.userId,
        kind: 'initial',
        status: GenerationRunStatus.queued,
        inputSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        inputHash: hashInputSnapshot(snapshot),
        ...(runOverrides as Prisma.GenerationRunUncheckedCreateInput),
      },
    });
    await prisma.book.update({ where: { id: book.id }, data: { activeRunId: run.id } });
    runIdsForOutboxCleanup.push(run.id);
    if (charged) {
      await creditsService.deductInTransaction(prisma, {
        userId: book.userId,
        amount: 1,
        reason: 'book_creation',
        bookId: book.id,
        idempotencyKey: generationChargeIdempotencyKey(run.id),
      });
    }
    await prisma.outboxEvent.create({
      data: {
        aggregateType: 'generation_run',
        aggregateId: run.id,
        eventType: 'run_queued',
        payload: { bookId: book.id, runId: run.id } as unknown as Prisma.InputJsonValue,
      },
    });
    return run;
  }

  function completedOutcome(overrides: Partial<GenerationOutcome> = {}): GenerationOutcome {
    return {
      status: 'complete' as GenerationOutcome['status'],
      completedStep: 'pdf_render' as GenerationOutcome['completedStep'],
      bookUpdate: { previewPdfUrl: '/files/books/storybook.pdf' },
      agentLogs: [],
      ...overrides,
    };
  }

  describe('Queued run', () => {
    it('commits Run + Book + outbox suppression + refund atomically', async () => {
      const book = await createUserAndBook(3);
      const run = await createRun(book);

      const result = await coordinator.cancelGeneration({ bookId: book.id, userId: book.userId });

      expect(result).toMatchObject({ kind: 'applied', creditsRefunded: 1, runId: run.id });
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.status).toBe(GenerationRunStatus.cancelled);
      expect(reloadedRun.cancelledAt).not.toBeNull();
      expect(reloadedRun.fencingVersion).toBe(1); // incremented from 0
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.status).toBe('cancelled');
      expect(reloadedBook.activeRunId).toBeNull();
      const outbox = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: run.id } });
      expect(outbox.status).toBe('cancelled');
      const reloadedUser = await prisma.user.findUniqueOrThrow({ where: { id: book.userId } });
      expect(reloadedUser.credits).toBe(3); // fully refunded
      const ledger = await prisma.creditTransaction.findMany({
        where: { userId: book.userId },
        orderBy: { createdAt: 'asc' },
      });
      expect(ledger).toHaveLength(2);
      expect(ledger[1]).toMatchObject({
        amount: 1,
        reason: 'refund_generation_cancelled',
        idempotencyKey: generationCancellationRefundIdempotencyKey(run.id),
      });
    });
  });

  describe('Running run', () => {
    it('invalidates the current fencing owner — a claimed worker loses ownership immediately', async () => {
      const book = await createUserAndBook(3);
      const run = await createRun(book);
      const claimed = await generationRunService.claim(run.id, 'token-a', 'worker-a', 60_000);

      const result = await coordinator.cancelGeneration({ bookId: book.id, userId: book.userId });

      expect(result.kind).toBe('applied');
      // The worker's own heartbeat, fenced on the pre-cancellation
      // (deliveryToken, fencingVersion) pair, must now fail — this is what
      // GenerationQueueProcessor's heartbeat loop uses to abort a
      // fenced-out attempt at its next checkpoint.
      const stillOwned = await generationRunService.heartbeat(
        run.id,
        'token-a',
        claimed!.fencingVersion,
        60_000,
      );
      expect(stillOwned).toBe(false);
    });

    it('a cancelled run cannot be reclaimed by a worker — claim() returns null', async () => {
      const book = await createUserAndBook(3);
      const run = await createRun(book);
      await generationRunService.claim(run.id, 'token-a', 'worker-a', 60_000);
      await coordinator.cancelGeneration({ bookId: book.id, userId: book.userId });

      const reclaimed = await generationRunService.claim(run.id, 'token-b', 'worker-b', 60_000);

      expect(reclaimed).toBeNull();
    });

    it('a cancelled run cannot be reclaimed by the recovery service — it never appears as a stale candidate', async () => {
      const book = await createUserAndBook(3);
      const run = await createRun(book);
      const claimed = await generationRunService.claim(run.id, 'token-a', 'worker-a', 60_000);
      await coordinator.cancelGeneration({ bookId: book.id, userId: book.userId });
      // Simulate the lease looking long-expired, the age signal recovery
      // would otherwise use to pick up an abandoned `running` run.
      await prisma.generationRun.update({
        where: { id: run.id },
        data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
      });
      const alwaysNotPending = { isJobStillPending: async () => false } as never;
      const recovery = new GenerationRunRecoveryService(prisma, alwaysNotPending, coordinator);

      const summary = await recovery.recover();

      expect(summary.staleFound).toBe(0);
      expect(summary.recovered).toBe(0);
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.status).toBe(GenerationRunStatus.cancelled); // untouched
      expect(reloadedRun.fencingVersion).toBe(claimed!.fencingVersion + 1); // only cancellation's own bump
    });
  });

  describe('Race semantics', () => {
    it('cancellation wins: a late completeRun is stale and writes no Book outcome, publication pointer, AgentLog, or second ledger mutation', async () => {
      const book = await createUserAndBook(3);
      const run = await createRun(book);
      const claimed = await generationRunService.claim(run.id, 'token-a', 'worker-a', 60_000);

      const cancelResult = await coordinator.cancelGeneration({
        bookId: book.id,
        userId: book.userId,
      });
      expect(cancelResult.kind).toBe('applied');

      // The old worker's own completeRun, still carrying the pre-
      // cancellation fencingVersion, finishes late.
      const completeResult = await coordinator.completeRun(
        { runId: run.id, bookId: book.id, fencingVersion: claimed!.fencingVersion },
        completedOutcome({
          agentLogs: [
            {
              bookId: book.id,
              agent: 'LocalPipelineAgent',
              step: 'pdf_render' as GenerationOutcome['completedStep'],
              status: 'success',
              attempt: 1,
              traceId: 'trace-late-complete',
            },
          ],
        }),
      );

      expect(completeResult).toBe('stale_fence');
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.status).toBe('cancelled'); // never flipped to complete
      expect(reloadedBook.previewPdfUrl).toBeNull(); // no publication pointer
      expect(reloadedBook.publishedRunId).toBeNull();
      const logs = await prisma.agentLog.findMany({ where: { bookId: book.id } });
      expect(logs).toHaveLength(0);
      const ledger = await prisma.creditTransaction.findMany({ where: { userId: book.userId } });
      expect(ledger).toHaveLength(2); // charge + cancellation refund only, no second mutation
      const reloadedUser = await prisma.user.findUniqueOrThrow({ where: { id: book.userId } });
      expect(reloadedUser.credits).toBe(3);
    });

    it('completion wins: cancellation returns conflict and creates no refund', async () => {
      const book = await createUserAndBook(3);
      const run = await createRun(book);
      const claimed = await generationRunService.claim(run.id, 'token-a', 'worker-a', 60_000);

      const completeResult = await coordinator.completeRun(
        { runId: run.id, bookId: book.id, fencingVersion: claimed!.fencingVersion },
        completedOutcome(),
      );
      expect(completeResult).toBe('applied');

      const cancelResult = await coordinator.cancelGeneration({
        bookId: book.id,
        userId: book.userId,
      });

      expect(cancelResult).toEqual({ kind: 'not_in_progress' });
      const ledger = await prisma.creditTransaction.findMany({ where: { userId: book.userId } });
      expect(ledger).toHaveLength(1); // the original charge only — no cancellation refund
      const reloadedUser = await prisma.user.findUniqueOrThrow({ where: { id: book.userId } });
      expect(reloadedUser.credits).toBe(2);
    });

    it('two concurrent cancellation requests (fired together via Promise.all — real overlapping transactions) produce exactly one applied transition, one conflict, and one refund', async () => {
      const book = await createUserAndBook(3);
      const run = await createRun(book);
      await generationRunService.claim(run.id, 'token-a', 'worker-a', 60_000);

      const [a, b] = await Promise.all([
        coordinator.cancelGeneration({ bookId: book.id, userId: book.userId }),
        coordinator.cancelGeneration({ bookId: book.id, userId: book.userId }),
      ]);

      const applied = [a, b].filter((r) => r.kind === 'applied');
      const alreadyCancelled = [a, b].filter((r) => r.kind === 'already_cancelled');
      expect(applied).toHaveLength(1);
      expect(alreadyCancelled).toHaveLength(1);

      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.status).toBe(GenerationRunStatus.cancelled);
      const ledger = await prisma.creditTransaction.findMany({
        where: { userId: book.userId, reason: 'refund_generation_cancelled' },
      });
      expect(ledger).toHaveLength(1); // exactly one refund, never two
      const reloadedUser = await prisma.user.findUniqueOrThrow({ where: { id: book.userId } });
      expect(reloadedUser.credits).toBe(3);
    });
  });

  describe('Refund insert failure', () => {
    it('rolls back the entire cancellation transaction — GenerationRun, Book, and outbox suppression all undone together', async () => {
      const book = await createUserAndBook(3);
      const run = await createRun(book);
      // Pre-occupy the deterministic cancellation-refund idempotency key
      // this cancellation would use, forcing the ledger INSERT inside the
      // coordinator's own refund step to hit the unique-constraint conflict
      // — the same technique generation-credit-charging.integration.spec.ts
      // uses to force the analogous failure-refund path, and the same
      // rollback mechanism 'book_mirror_mismatch' relies on (see this file's
      // top-level doc comment).
      await prisma.creditTransaction.create({
        data: {
          userId: book.userId,
          amount: 1,
          balanceAfter: 999,
          reason: 'refund_generation_cancelled',
          idempotencyKey: generationCancellationRefundIdempotencyKey(run.id),
        },
      });

      await expect(
        coordinator.cancelGeneration({ bookId: book.id, userId: book.userId }),
      ).rejects.toThrow();

      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.status).toBe(GenerationRunStatus.queued); // never reached 'cancelled'
      expect(reloadedRun.cancelledAt).toBeNull();
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.status).not.toBe('cancelled');
      expect(reloadedBook.activeRunId).toBe(run.id); // never cleared
      const outbox = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: run.id } });
      expect(outbox.status).toBe('pending'); // never suppressed
      const reloadedUser = await prisma.user.findUniqueOrThrow({ where: { id: book.userId } });
      expect(reloadedUser.credits).toBe(2); // unchanged from the original charge
    });
  });

  describe('Legacy run', () => {
    it('cancellation succeeds with zero refund for a run that predates generation credit charging', async () => {
      const book = await createUserAndBook(3);
      const run = await createRun(book, { charged: false });

      const result = await coordinator.cancelGeneration({ bookId: book.id, userId: book.userId });

      expect(result).toMatchObject({ kind: 'applied', creditsRefunded: 0 });
      const reloadedUser = await prisma.user.findUniqueOrThrow({ where: { id: book.userId } });
      expect(reloadedUser.credits).toBe(3); // untouched — no charge existed, so no refund either
      const ledger = await prisma.creditTransaction.findMany({ where: { userId: book.userId } });
      expect(ledger).toHaveLength(0);
    });
  });

  describe('Outbox race', () => {
    it('dispatch-before-cancel: a suppression that races an already-dispatched event leaves it dispatched, untouched, and cancellation still succeeds', async () => {
      const book = await createUserAndBook(3);
      const run = await createRun(book);
      // Simulate the dispatcher sweep having already published this event to
      // BullMQ and marked it dispatched, milliseconds before the
      // cancellation request lands.
      const outbox = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: run.id } });
      await outboxService.markDispatched(outbox.id);

      const result = await coordinator.cancelGeneration({ bookId: book.id, userId: book.userId });

      expect(result.kind).toBe('applied');
      const reloadedOutbox = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: outbox.id },
      });
      // cancelGeneration's outbox suppression only ever matches
      // status: 'pending' — an already-dispatched event is never falsely
      // relabeled or described as suppressed.
      expect(reloadedOutbox.status).toBe(OUTBOX_STATUS_DISPATCHED);
    });

    it('cancel-before-dispatch: a suppressed event is never picked up by a later dispatcher sweep', async () => {
      const book = await createUserAndBook(3);
      const run = await createRun(book);

      const cancelResult = await coordinator.cancelGeneration({
        bookId: book.id,
        userId: book.userId,
      });
      expect(cancelResult.kind).toBe('applied');

      // Tracks by runId, not a bare "was enqueue ever called" flag — this
      // suite runs against a shared dev Postgres, so an unrelated pending
      // event left by another describe block (or another test file) could
      // otherwise make this assertion flaky for reasons unrelated to what's
      // being tested here.
      const enqueuedRunIds: string[] = [];
      const spiedQueueService = {
        enqueue: async (data: { runId: string }) => {
          enqueuedRunIds.push(data.runId);
        },
      } as never;
      const dispatcher = new OutboxDispatcherService(outboxService, spiedQueueService);

      await dispatcher.sweep();

      expect(enqueuedRunIds).not.toContain(run.id);
      const outbox = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: run.id } });
      expect(outbox.status).toBe('cancelled');
    });
  });
});
