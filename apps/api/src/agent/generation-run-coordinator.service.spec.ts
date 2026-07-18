import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { CreditTransaction } from '@prisma/client';
import { GenerationRunCoordinator } from './generation-run-coordinator.service';
import { GENERATION_INPUT_SNAPSHOT_INVALID } from './generation-input-snapshot';
import type { GenerationOutcome } from './generation-outcome';
import { createMockPrisma } from '../common/test-utils/mock-prisma';
import type { CreditsService } from '../credits/credits.service';

type MockPrisma = ReturnType<typeof createMockPrisma>;

function makeChargeTransaction(overrides: Partial<CreditTransaction> = {}): CreditTransaction {
  return {
    id: 'charge-tx-1',
    userId: 'u-1',
    bookId: 'b-1',
    amount: -1,
    balanceAfter: 2,
    reason: 'book_creation' as CreditTransaction['reason'],
    stripePaymentId: null,
    idempotencyKey: 'generation:run-1:charge',
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function createMockCreditsService(): jest.Mocked<CreditsService> {
  return {
    addInTransaction: vi.fn().mockResolvedValue(makeChargeTransaction({ amount: 1 })),
  } as unknown as jest.Mocked<CreditsService>;
}

function makeOutcome(overrides: Partial<GenerationOutcome> = {}): GenerationOutcome {
  return {
    status: 'complete' as GenerationOutcome['status'],
    completedStep: 'pdf_render' as GenerationOutcome['completedStep'],
    bookUpdate: { previewPdfUrl: '/files/books/b-1/storybook.pdf' },
    agentLogs: [
      {
        bookId: 'b-1',
        agent: 'LocalPipelineAgent',
        step: 'pdf_render' as GenerationOutcome['completedStep'],
        status: 'success',
        attempt: 1,
        traceId: 'trace-1',
      },
    ],
    ...overrides,
  };
}

describe('GenerationRunCoordinator', () => {
  let prisma: MockPrisma;
  let creditsService: ReturnType<typeof createMockCreditsService>;
  let coordinator: GenerationRunCoordinator;

  beforeEach(() => {
    prisma = createMockPrisma();
    prisma.$transaction.mockImplementation((cb: (tx: MockPrisma) => unknown) => cb(prisma));
    prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.book.updateMany.mockResolvedValue({ count: 1 });
    // Default: no matching charge — most existing tests below predate Phase
    // E2 credit charging and don't care about refund behavior; tests that do
    // override this explicitly.
    prisma.creditTransaction.findUnique.mockResolvedValue(null);
    creditsService = createMockCreditsService();
    coordinator = new GenerationRunCoordinator(prisma as never, creditsService as never);
  });

  describe('completeRun', () => {
    it('on success: transitions GenerationRun to completed and Book to complete, atomically setting both publishedRunId and publishedRunFencingVersion, and returns "applied"', async () => {
      const outcome = makeOutcome();

      const result = await coordinator.completeRun(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 3 },
        outcome,
      );

      expect(result).toBe('applied');
      expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
        where: { id: 'run-1', status: 'running', fencingVersion: 3 },
        data: { status: 'completed', completedAt: expect.any(Date), currentStep: 'pdf_render' },
      });
      expect(prisma.book.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', activeRunId: 'run-1' },
        data: {
          previewPdfUrl: '/files/books/b-1/storybook.pdf',
          status: 'complete',
          activeRunId: null,
          publishedRunId: 'run-1',
          publishedRunFencingVersion: 3,
        },
      });
    });

    it('on an expected content failure: transitions both to failed, never sets either published pointer field', async () => {
      const outcome = makeOutcome({
        status: 'failed' as GenerationOutcome['status'],
        errorCode: 'GENERATION_FAILED',
        errorMessage: 'OpenAI image request failed',
        failedStep: 'image_gen' as GenerationOutcome['failedStep'],
        bookUpdate: {},
      });

      await coordinator.completeRun({ runId: 'run-1', bookId: 'b-1', fencingVersion: 0 }, outcome);

      expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
        where: { id: 'run-1', status: 'running', fencingVersion: 0 },
        data: {
          status: 'failed',
          failedAt: expect.any(Date),
          errorCode: 'GENERATION_FAILED',
          errorMessage: 'OpenAI image request failed',
          currentStep: 'pdf_render',
        },
      });
      const bookCall = prisma.book.updateMany.mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };
      expect(bookCall.data['publishedRunId']).toBeUndefined();
      expect(bookCall.data['publishedRunFencingVersion']).toBeUndefined();
      expect(bookCall.data['status']).toBe('failed');
      expect(bookCall.data['failedStep']).toBe('image_gen');
    });

    it('persists outcome.agentLogs via tx.agentLog.createMany only after the GenerationRun fence and Book mirror check both hold', async () => {
      const outcome = makeOutcome({
        agentLogs: [
          {
            bookId: 'b-1',
            agent: 'LocalPipelineAgent',
            step: 'char_build' as GenerationOutcome['completedStep'],
            status: 'success',
            attempt: 1,
            traceId: 'trace-42',
          },
          {
            bookId: 'b-1',
            agent: 'LocalPipelineAgent',
            step: 'pdf_render' as GenerationOutcome['completedStep'],
            status: 'success',
            attempt: 1,
            traceId: 'trace-42',
          },
        ],
      });

      const result = await coordinator.completeRun(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 3 },
        outcome,
      );

      expect(result).toBe('applied');
      expect(prisma.agentLog.createMany).toHaveBeenCalledWith({ data: outcome.agentLogs });
    });

    it('never calls tx.agentLog.createMany when outcome.agentLogs is empty', async () => {
      await coordinator.completeRun(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 3 },
        makeOutcome({ agentLogs: [] }),
      );

      expect(prisma.agentLog.createMany).not.toHaveBeenCalled();
    });

    it('returns "stale_fence" and never touches Book or AgentLog when the GenerationRun fencing check finds this attempt already superseded', async () => {
      prisma.generationRun.updateMany.mockResolvedValue({ count: 0 });

      const result = await coordinator.completeRun(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 3 },
        makeOutcome(),
      );

      expect(result).toBe('stale_fence');
      expect(prisma.book.updateMany).not.toHaveBeenCalled();
      expect(prisma.agentLog.createMany).not.toHaveBeenCalled();
    });

    it('logs a warning (not an error) for stale_fence — an expected race, not a bug', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      prisma.generationRun.updateMany.mockResolvedValue({ count: 0 });

      await coordinator.completeRun(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 3 },
        makeOutcome(),
      );

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already superseded'));
      warnSpy.mockRestore();
    });

    it('returns "book_mirror_mismatch" (distinct from stale_fence), never calls tx.agentLog.createMany, and logs at error severity when the run fence holds but Book.activeRunId no longer matches', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });
      prisma.book.updateMany.mockResolvedValue({ count: 0 });

      const result = await coordinator.completeRun(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 3 },
        makeOutcome(),
      );

      expect(result).toBe('book_mirror_mismatch');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('mirror invariant is broken'));
      expect(prisma.agentLog.createMany).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('rolls back the entire transaction (GenerationRun write included) on a book_mirror_mismatch, not just the Book write', async () => {
      // The real Prisma $transaction would roll back automatically once the
      // callback throws — this test's own mock only calls the callback
      // directly, so it can't observe a real rollback, but it does prove the
      // callback throws (rather than committing a partial write) exactly
      // when the mismatch is detected, which is what makes a real
      // transaction roll back.
      prisma.$transaction.mockImplementation(async (cb: (tx: MockPrisma) => unknown) => {
        try {
          return await cb(prisma);
        } catch (err) {
          throw err;
        }
      });
      prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });
      prisma.book.updateMany.mockResolvedValue({ count: 0 });

      const result = await coordinator.completeRun(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 3 },
        makeOutcome(),
      );

      expect(result).toBe('book_mirror_mismatch');
    });

    describe('Phase E2 — refund on failure', () => {
      it('refunds the exact amount/user/book from the matching charge transaction when a run fails', async () => {
        prisma.creditTransaction.findUnique.mockResolvedValue(
          makeChargeTransaction({ userId: 'u-9', bookId: 'b-9', amount: -1 }),
        );

        const result = await coordinator.completeRun(
          { runId: 'run-1', bookId: 'b-1', fencingVersion: 0 },
          makeOutcome({ status: 'failed' as GenerationOutcome['status'], bookUpdate: {} }),
        );

        expect(result).toBe('applied');
        expect(prisma.creditTransaction.findUnique).toHaveBeenCalledWith({
          where: { idempotencyKey: 'generation:run-1:charge' },
        });
        expect(creditsService.addInTransaction).toHaveBeenCalledWith(prisma, {
          userId: 'u-9',
          amount: 1,
          reason: 'refund_generation_failure',
          bookId: 'b-9',
          idempotencyKey: 'generation:run-1:refund',
        });
      });

      it('never refunds a successful completion, even when a matching charge exists', async () => {
        prisma.creditTransaction.findUnique.mockResolvedValue(makeChargeTransaction());

        await coordinator.completeRun(
          { runId: 'run-1', bookId: 'b-1', fencingVersion: 3 },
          makeOutcome(),
        );

        expect(prisma.creditTransaction.findUnique).not.toHaveBeenCalled();
        expect(creditsService.addInTransaction).not.toHaveBeenCalled();
      });

      it('never refunds a legacy/unbilled run — no matching charge transaction exists', async () => {
        prisma.creditTransaction.findUnique.mockResolvedValue(null);

        const result = await coordinator.completeRun(
          { runId: 'run-1', bookId: 'b-1', fencingVersion: 0 },
          makeOutcome({ status: 'failed' as GenerationOutcome['status'], bookUpdate: {} }),
        );

        expect(result).toBe('applied');
        expect(creditsService.addInTransaction).not.toHaveBeenCalled();
      });

      it('never refunds on a stale fence — the refund lookup never runs', async () => {
        prisma.generationRun.updateMany.mockResolvedValue({ count: 0 });
        prisma.creditTransaction.findUnique.mockResolvedValue(makeChargeTransaction());

        const result = await coordinator.completeRun(
          { runId: 'run-1', bookId: 'b-1', fencingVersion: 3 },
          makeOutcome({ status: 'failed' as GenerationOutcome['status'], bookUpdate: {} }),
        );

        expect(result).toBe('stale_fence');
        expect(prisma.creditTransaction.findUnique).not.toHaveBeenCalled();
        expect(creditsService.addInTransaction).not.toHaveBeenCalled();
      });

      it('never refunds on a book mirror mismatch — the refund lookup never runs', async () => {
        prisma.book.updateMany.mockResolvedValue({ count: 0 });
        prisma.creditTransaction.findUnique.mockResolvedValue(makeChargeTransaction());

        const result = await coordinator.completeRun(
          { runId: 'run-1', bookId: 'b-1', fencingVersion: 3 },
          makeOutcome({ status: 'failed' as GenerationOutcome['status'], bookUpdate: {} }),
        );

        expect(result).toBe('book_mirror_mismatch');
        expect(prisma.creditTransaction.findUnique).not.toHaveBeenCalled();
        expect(creditsService.addInTransaction).not.toHaveBeenCalled();
      });
    });
  });

  describe('failInvalidSnapshot', () => {
    it('fails both GenerationRun and Book with the stable GENERATION_INPUT_SNAPSHOT_INVALID code', async () => {
      const result = await coordinator.failInvalidSnapshot(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 1 },
        'This book’s saved generation request is invalid.',
      );

      expect(result).toBe('applied');
      expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
        where: { id: 'run-1', status: 'running', fencingVersion: 1 },
        data: {
          status: 'failed',
          failedAt: expect.any(Date),
          errorCode: GENERATION_INPUT_SNAPSHOT_INVALID,
          errorMessage: 'This book’s saved generation request is invalid.',
        },
      });
      expect(prisma.book.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', activeRunId: 'run-1' },
        data: {
          activeRunId: null,
          status: 'failed',
          errorMessage: 'This book’s saved generation request is invalid.',
        },
      });
    });

    it('returns "stale_fence" without touching Book when already superseded', async () => {
      prisma.generationRun.updateMany.mockResolvedValue({ count: 0 });

      const result = await coordinator.failInvalidSnapshot(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 1 },
        'invalid',
      );

      expect(result).toBe('stale_fence');
      expect(prisma.book.updateMany).not.toHaveBeenCalled();
    });

    it('returns "book_mirror_mismatch" when the run fence holds but Book does not match', async () => {
      prisma.book.updateMany.mockResolvedValue({ count: 0 });

      const result = await coordinator.failInvalidSnapshot(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 1 },
        'invalid',
      );

      expect(result).toBe('book_mirror_mismatch');
    });

    it('requests one refund when a matching charge exists', async () => {
      prisma.creditTransaction.findUnique.mockResolvedValue(
        makeChargeTransaction({ userId: 'u-1', bookId: 'b-1', amount: -1 }),
      );

      await coordinator.failInvalidSnapshot(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 1 },
        'invalid',
      );

      expect(creditsService.addInTransaction).toHaveBeenCalledWith(prisma, {
        userId: 'u-1',
        amount: 1,
        reason: 'refund_generation_failure',
        bookId: 'b-1',
        idempotencyKey: 'generation:run-1:refund',
      });
    });

    it('never refunds a legacy/unbilled run — no matching charge transaction exists', async () => {
      prisma.creditTransaction.findUnique.mockResolvedValue(null);

      await coordinator.failInvalidSnapshot(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 1 },
        'invalid',
      );

      expect(creditsService.addInTransaction).not.toHaveBeenCalled();
    });
  });

  describe('failAbandoned', () => {
    it('fences on the caller-observed fromStatus (running) for BullMQ retry exhaustion', async () => {
      const result = await coordinator.failAbandoned(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 2, fromStatus: 'running' },
        {
          errorCode: 'GENERATION_INFRASTRUCTURE_FAILURE',
          errorMessage: 'Generation failed after repeated errors.',
        },
      );

      expect(result).toBe('applied');
      expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
        where: { id: 'run-1', status: 'running', fencingVersion: 2 },
        data: {
          status: 'failed',
          failedAt: expect.any(Date),
          errorCode: 'GENERATION_INFRASTRUCTURE_FAILURE',
          errorMessage: 'Generation failed after repeated errors.',
        },
      });
      expect(prisma.book.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', activeRunId: 'run-1' },
        data: {
          activeRunId: null,
          status: 'failed',
          failedStep: null,
          errorMessage: 'Generation failed after repeated errors.',
        },
      });
    });

    it('fences on fromStatus "queued" for a never-claimed abandoned run (recovery sweep)', async () => {
      await coordinator.failAbandoned(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 0, fromStatus: 'queued' },
        { errorCode: 'GENERATION_ABANDONED', errorMessage: 'Generation was interrupted.' },
      );

      expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
        where: { id: 'run-1', status: 'queued', fencingVersion: 0 },
        data: expect.objectContaining({ status: 'failed', errorCode: 'GENERATION_ABANDONED' }),
      });
    });

    it('returns "stale_fence" without touching Book when a live worker already moved the run on', async () => {
      prisma.generationRun.updateMany.mockResolvedValue({ count: 0 });

      const result = await coordinator.failAbandoned(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 2, fromStatus: 'running' },
        { errorCode: 'GENERATION_ABANDONED', errorMessage: 'interrupted' },
      );

      expect(result).toBe('stale_fence');
      expect(prisma.book.updateMany).not.toHaveBeenCalled();
    });

    it('returns "book_mirror_mismatch" when the run fence holds but Book does not match', async () => {
      prisma.book.updateMany.mockResolvedValue({ count: 0 });

      const result = await coordinator.failAbandoned(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 2, fromStatus: 'running' },
        { errorCode: 'GENERATION_ABANDONED', errorMessage: 'interrupted' },
      );

      expect(result).toBe('book_mirror_mismatch');
    });

    it('requests one refund when a matching charge exists (BullMQ retry exhaustion / recovery sweep)', async () => {
      prisma.creditTransaction.findUnique.mockResolvedValue(
        makeChargeTransaction({ userId: 'u-1', bookId: 'b-1', amount: -1 }),
      );

      await coordinator.failAbandoned(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 2, fromStatus: 'running' },
        { errorCode: 'GENERATION_ABANDONED', errorMessage: 'interrupted' },
      );

      expect(creditsService.addInTransaction).toHaveBeenCalledWith(prisma, {
        userId: 'u-1',
        amount: 1,
        reason: 'refund_generation_failure',
        bookId: 'b-1',
        idempotencyKey: 'generation:run-1:refund',
      });
    });

    it('never refunds a legacy/unbilled run — no matching charge transaction exists', async () => {
      prisma.creditTransaction.findUnique.mockResolvedValue(null);

      await coordinator.failAbandoned(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 2, fromStatus: 'running' },
        { errorCode: 'GENERATION_ABANDONED', errorMessage: 'interrupted' },
      );

      expect(creditsService.addInTransaction).not.toHaveBeenCalled();
    });
  });

  describe('cancelGeneration (Phase G1)', () => {
    function makeBook(overrides: Record<string, unknown> = {}) {
      return {
        id: 'b-1',
        userId: 'u-1',
        status: 'char_build',
        activeRunId: 'run-1',
        deletedAt: null,
        ...overrides,
      };
    }

    function makeRun(overrides: Record<string, unknown> = {}) {
      return {
        id: 'run-1',
        bookId: 'b-1',
        userId: 'u-1',
        status: 'running',
        fencingVersion: 2,
        ...overrides,
      };
    }

    beforeEach(() => {
      prisma.book.findFirst.mockResolvedValue(makeBook());
      prisma.generationRun.findFirst.mockResolvedValue(makeRun());
      prisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
      prisma.book.findUniqueOrThrow.mockResolvedValue(
        makeBook({ status: 'cancelled', activeRunId: null }),
      );
    });

    it('applies cancellation for a running run, fences on id/bookId/userId/status/fencingVersion, bumps fencingVersion, and sets cancelledAt', async () => {
      const result = await coordinator.cancelGeneration({ bookId: 'b-1', userId: 'u-1' });

      expect(result.kind).toBe('applied');
      expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
        where: { id: 'run-1', bookId: 'b-1', userId: 'u-1', status: 'running', fencingVersion: 2 },
        data: {
          status: 'cancelled',
          cancelledAt: expect.any(Date),
          fencingVersion: { increment: 1 },
        },
      });
    });

    it('applies cancellation for a queued (never-claimed) run', async () => {
      prisma.generationRun.findFirst.mockResolvedValue(
        makeRun({ status: 'queued', fencingVersion: 0 }),
      );

      const result = await coordinator.cancelGeneration({ bookId: 'b-1', userId: 'u-1' });

      expect(result.kind).toBe('applied');
      expect(prisma.generationRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'queued', fencingVersion: 0 }),
        }),
      );
    });

    it('conditionally updates Book to cancelled, clears activeRunId/errorMessage/failedStep, and never touches published pointer fields', async () => {
      await coordinator.cancelGeneration({ bookId: 'b-1', userId: 'u-1' });

      expect(prisma.book.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', userId: 'u-1', activeRunId: 'run-1' },
        data: { status: 'cancelled', activeRunId: null, errorMessage: null, failedStep: null },
      });
    });

    it('suppresses a pending outbox event for this run, never touching a dispatched/other event', async () => {
      await coordinator.cancelGeneration({ bookId: 'b-1', userId: 'u-1' });

      expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
        where: { aggregateType: 'generation_run', aggregateId: 'run-1', status: 'pending' },
        data: { status: 'cancelled' },
      });
    });

    it('refunds the exact amount/user/book from the matching charge, using reason refund_generation_cancelled and a distinct idempotency key from the failure-refund path', async () => {
      prisma.creditTransaction.findUnique.mockResolvedValue(
        makeChargeTransaction({ userId: 'u-9', bookId: 'b-9', amount: -1 }),
      );

      const result = await coordinator.cancelGeneration({ bookId: 'b-1', userId: 'u-1' });

      expect(result).toMatchObject({ kind: 'applied', creditsRefunded: 1, runId: 'run-1' });
      expect(prisma.creditTransaction.findUnique).toHaveBeenCalledWith({
        where: { idempotencyKey: 'generation:run-1:charge' },
      });
      expect(creditsService.addInTransaction).toHaveBeenCalledWith(prisma, {
        userId: 'u-9',
        amount: 1,
        reason: 'refund_generation_cancelled',
        bookId: 'b-9',
        idempotencyKey: 'generation:run-1:cancel_refund',
      });
    });

    it('returns creditsRefunded: 0 and never calls addInTransaction for a legacy/unbilled run', async () => {
      prisma.creditTransaction.findUnique.mockResolvedValue(null);

      const result = await coordinator.cancelGeneration({ bookId: 'b-1', userId: 'u-1' });

      expect(result).toMatchObject({ kind: 'applied', creditsRefunded: 0 });
      expect(creditsService.addInTransaction).not.toHaveBeenCalled();
    });

    it('returns "not_found" when no Book matches (missing, not owned, or soft-deleted)', async () => {
      prisma.book.findFirst.mockResolvedValue(null);

      const result = await coordinator.cancelGeneration({ bookId: 'missing', userId: 'u-1' });

      expect(result).toEqual({ kind: 'not_found' });
      expect(prisma.generationRun.findFirst).not.toHaveBeenCalled();
    });

    it('returns "already_cancelled" (fast path) when Book.activeRunId is null and Book.status is already cancelled', async () => {
      prisma.book.findFirst.mockResolvedValue(makeBook({ activeRunId: null, status: 'cancelled' }));

      const result = await coordinator.cancelGeneration({ bookId: 'b-1', userId: 'u-1' });

      expect(result).toEqual({ kind: 'already_cancelled' });
      expect(prisma.generationRun.findFirst).not.toHaveBeenCalled();
      expect(prisma.generationRun.updateMany).not.toHaveBeenCalled();
    });

    it.each(['created', 'complete', 'failed', 'partial'])(
      'returns "not_in_progress" (fast path) when Book.activeRunId is null and Book.status is "%s"',
      async (status) => {
        prisma.book.findFirst.mockResolvedValue(makeBook({ activeRunId: null, status }));

        const result = await coordinator.cancelGeneration({ bookId: 'b-1', userId: 'u-1' });

        expect(result).toEqual({ kind: 'not_in_progress' });
      },
    );

    it('returns "not_in_progress" when the run referenced by activeRunId is already completed', async () => {
      prisma.generationRun.findFirst.mockResolvedValue(makeRun({ status: 'completed' }));

      const result = await coordinator.cancelGeneration({ bookId: 'b-1', userId: 'u-1' });

      expect(result).toEqual({ kind: 'not_in_progress' });
      expect(prisma.generationRun.updateMany).not.toHaveBeenCalled();
    });

    it('returns "already_cancelled" when the run referenced by activeRunId is already cancelled (Book row observed stale relative to the run row)', async () => {
      prisma.generationRun.findFirst.mockResolvedValue(makeRun({ status: 'cancelled' }));

      const result = await coordinator.cancelGeneration({ bookId: 'b-1', userId: 'u-1' });

      expect(result).toEqual({ kind: 'already_cancelled' });
      expect(prisma.generationRun.updateMany).not.toHaveBeenCalled();
    });

    it('re-reads and returns "already_cancelled" when the fenced update loses a race against a concurrent cancellation', async () => {
      prisma.generationRun.updateMany.mockResolvedValue({ count: 0 });
      prisma.generationRun.findUnique.mockResolvedValue(makeRun({ status: 'cancelled' }));

      const result = await coordinator.cancelGeneration({ bookId: 'b-1', userId: 'u-1' });

      expect(result).toEqual({ kind: 'already_cancelled' });
      expect(prisma.book.updateMany).not.toHaveBeenCalled();
      expect(creditsService.addInTransaction).not.toHaveBeenCalled();
    });

    it('re-reads and returns "not_in_progress" when the fenced update loses a race against a concurrent completion', async () => {
      prisma.generationRun.updateMany.mockResolvedValue({ count: 0 });
      prisma.generationRun.findUnique.mockResolvedValue(makeRun({ status: 'completed' }));

      const result = await coordinator.cancelGeneration({ bookId: 'b-1', userId: 'u-1' });

      expect(result).toEqual({ kind: 'not_in_progress' });
      expect(prisma.book.updateMany).not.toHaveBeenCalled();
    });

    it('returns "book_mirror_mismatch", never refunds, and never suppresses the outbox when the run fence holds but Book.activeRunId no longer matches', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      prisma.book.updateMany.mockResolvedValue({ count: 0 });
      prisma.creditTransaction.findUnique.mockResolvedValue(makeChargeTransaction());

      const result = await coordinator.cancelGeneration({ bookId: 'b-1', userId: 'u-1' });

      expect(result).toEqual({ kind: 'book_mirror_mismatch', runId: 'run-1', bookId: 'b-1' });
      expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
      expect(creditsService.addInTransaction).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });
});
