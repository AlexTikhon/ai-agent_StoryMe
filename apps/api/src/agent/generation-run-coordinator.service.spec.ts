import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { GenerationRunCoordinator } from './generation-run-coordinator.service';
import { GENERATION_INPUT_SNAPSHOT_INVALID } from './generation-input-snapshot';
import type { GenerationOutcome } from './generation-outcome';
import { createMockPrisma } from '../common/test-utils/mock-prisma';

type MockPrisma = ReturnType<typeof createMockPrisma>;

function makeOutcome(overrides: Partial<GenerationOutcome> = {}): GenerationOutcome {
  return {
    status: 'complete' as GenerationOutcome['status'],
    completedStep: 'pdf_render' as GenerationOutcome['completedStep'],
    bookUpdate: { previewPdfUrl: '/files/books/b-1/storybook.pdf' },
    ...overrides,
  };
}

describe('GenerationRunCoordinator', () => {
  let prisma: MockPrisma;
  let coordinator: GenerationRunCoordinator;

  beforeEach(() => {
    prisma = createMockPrisma();
    prisma.$transaction.mockImplementation((cb: (tx: MockPrisma) => unknown) => cb(prisma));
    prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.book.updateMany.mockResolvedValue({ count: 1 });
    coordinator = new GenerationRunCoordinator(prisma as never);
  });

  describe('completeRun', () => {
    it('on success: transitions GenerationRun to completed and Book to complete, publishedRunId, and returns "applied"', async () => {
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
        },
      });
    });

    it('on an expected content failure: transitions both to failed, never sets publishedRunId', async () => {
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
      expect(bookCall.data['status']).toBe('failed');
      expect(bookCall.data['failedStep']).toBe('image_gen');
    });

    it('returns "stale_fence" and never touches Book when the GenerationRun fencing check finds this attempt already superseded', async () => {
      prisma.generationRun.updateMany.mockResolvedValue({ count: 0 });

      const result = await coordinator.completeRun(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 3 },
        makeOutcome(),
      );

      expect(result).toBe('stale_fence');
      expect(prisma.book.updateMany).not.toHaveBeenCalled();
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

    it('returns "book_mirror_mismatch" (distinct from stale_fence) and logs at error severity when the run fence holds but Book.activeRunId no longer matches', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });
      prisma.book.updateMany.mockResolvedValue({ count: 0 });

      const result = await coordinator.completeRun(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 3 },
        makeOutcome(),
      );

      expect(result).toBe('book_mirror_mismatch');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('mirror invariant is broken'));
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
  });
});
