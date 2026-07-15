import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { GenerationRun } from '@prisma/client';
import { GenerationQueueProcessor } from './generation-queue.processor';
import type { BooksService } from '../books/books.service';
import type { GenerationRunService } from './generation-run.service';
import type { GenerationQueueJobData } from './generation-queue.service';

const VALID_SNAPSHOT = {
  childName: 'Alex',
  childAge: 6,
  language: 'en',
  theme: 'adventure',
  educationalMessage: null,
  pageCount: 6,
  childPhoto: null,
};

function makeGenerationRun(overrides: Partial<GenerationRun> = {}): GenerationRun {
  return {
    id: 'run-1',
    bookId: 'b-1',
    userId: 'u-1',
    kind: 'initial' as GenerationRun['kind'],
    status: 'running' as GenerationRun['status'],
    inputSnapshot: VALID_SNAPSHOT,
    inputHash: 'hash-1',
    retryOfRunId: null,
    currentStep: null,
    attempt: 1,
    leaseOwner: 'worker-1',
    leaseExpiresAt: new Date('2026-01-01T01:00:00.000Z'),
    leaseAttempt: 1,
    fencingVersion: 1,
    errorCode: null,
    errorMessage: null,
    startedAt: new Date('2026-01-01'),
    completedAt: null,
    failedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function createMockBooksService(): jest.Mocked<BooksService> {
  return {
    runGenerationPipeline: vi.fn().mockResolvedValue(undefined),
    markRunPermanentlyFailedAfterExhaustedRetries: vi.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<BooksService>;
}

function createMockGenerationRunService(
  claimed: GenerationRun | null = makeGenerationRun(),
): jest.Mocked<GenerationRunService> {
  return {
    claim: vi.fn().mockResolvedValue(claimed),
    heartbeat: vi.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<GenerationRunService>;
}

function makeJob(data: GenerationQueueJobData): Job<GenerationQueueJobData> {
  return { data, attemptsMade: 0, opts: { attempts: 3 } } as unknown as Job<GenerationQueueJobData>;
}

describe('GenerationQueueProcessor', () => {
  describe('process', () => {
    it('claims the run before delegating to BooksService.runGenerationPipeline', async () => {
      const booksService = createMockBooksService();
      const claimed = makeGenerationRun();
      const generationRunService = createMockGenerationRunService(claimed);
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
      );

      await processor.process(makeJob({ bookId: 'b-1', runId: 'run-1' }));

      expect(generationRunService.claim).toHaveBeenCalledWith(
        'run-1',
        expect.any(String),
        expect.any(Number),
        1,
      );
      expect(booksService.runGenerationPipeline).toHaveBeenCalledWith({
        runId: claimed.id,
        bookId: claimed.bookId,
        fencingVersion: claimed.fencingVersion,
        inputHash: claimed.inputHash,
        inputSnapshot: VALID_SNAPSHOT,
      });
    });

    it('is a no-op (does not call runGenerationPipeline) when the claim fails — already terminal or leased elsewhere', async () => {
      const booksService = createMockBooksService();
      const generationRunService = createMockGenerationRunService(null);
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
      );

      await expect(
        processor.process(makeJob({ bookId: 'b-1', runId: 'run-1' })),
      ).resolves.toBeUndefined();

      expect(booksService.runGenerationPipeline).not.toHaveBeenCalled();
    });

    it('propagates a rejection from runGenerationPipeline (an unexpected/transient failure BullMQ should retry)', async () => {
      const booksService = createMockBooksService();
      booksService.runGenerationPipeline.mockRejectedValue(new Error('unexpected'));
      const generationRunService = createMockGenerationRunService();
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
      );

      await expect(processor.process(makeJob({ bookId: 'b-1', runId: 'run-1' }))).rejects.toThrow(
        'unexpected',
      );
    });

    it('logs the BullMQ job id, bookId, and runId when picking up a job', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const booksService = createMockBooksService();
      const generationRunService = createMockGenerationRunService();
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
      );
      const job = {
        ...makeJob({ bookId: 'b-1', runId: 'run-1' }),
        id: 'bullmq-42',
      } as Job<GenerationQueueJobData>;

      await processor.process(job);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('bullmqJobId=bullmq-42 bookId=b-1 runId=run-1 attempt=1/3'),
      );
      logSpy.mockRestore();
    });
  });

  it('logs on the completed worker event', () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const booksService = createMockBooksService();
    const generationRunService = createMockGenerationRunService();
    const processor = new GenerationQueueProcessor(
      booksService as never,
      generationRunService as never,
    );
    const job = {
      ...makeJob({ bookId: 'b-1', runId: 'run-1' }),
      id: 'bullmq-42',
    } as Job<GenerationQueueJobData>;

    processor.onCompleted(job);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('bullmqJobId=bullmq-42 bookId=b-1 runId=run-1'),
    );
    logSpy.mockRestore();
  });

  describe('onFailed', () => {
    it('logs a safe error message without throwing on an undefined job', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const booksService = createMockBooksService();
      const generationRunService = createMockGenerationRunService();
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
      );

      await processor.onFailed(undefined, new Error('Redis connection refused'));

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('error=Error: Redis connection refused'),
        expect.any(String),
      );
      errorSpy.mockRestore();
    });

    it('does not finalize the run when more BullMQ attempts remain', async () => {
      const booksService = createMockBooksService();
      const generationRunService = createMockGenerationRunService();
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
      );
      const job = {
        ...makeJob({ bookId: 'b-1', runId: 'run-1' }),
        attemptsMade: 1,
        opts: { attempts: 3 },
      } as Job<GenerationQueueJobData>;

      await processor.onFailed(job, new Error('transient'));

      expect(booksService.markRunPermanentlyFailedAfterExhaustedRetries).not.toHaveBeenCalled();
    });

    it('finalizes the run once every BullMQ attempt is exhausted', async () => {
      const booksService = createMockBooksService();
      const generationRunService = createMockGenerationRunService();
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
      );
      const job = {
        ...makeJob({ bookId: 'b-1', runId: 'run-1' }),
        attemptsMade: 3,
        opts: { attempts: 3 },
      } as Job<GenerationQueueJobData>;

      await processor.onFailed(job, new Error('transient'));

      expect(booksService.markRunPermanentlyFailedAfterExhaustedRetries).toHaveBeenCalledWith(
        'run-1',
      );
    });

    it('swallows (logs, does not throw) a failure finalizing the exhausted run', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const booksService = createMockBooksService();
      booksService.markRunPermanentlyFailedAfterExhaustedRetries.mockRejectedValue(
        new Error('db down'),
      );
      const generationRunService = createMockGenerationRunService();
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
      );
      const job = {
        ...makeJob({ bookId: 'b-1', runId: 'run-1' }),
        attemptsMade: 3,
        opts: { attempts: 3 },
      } as Job<GenerationQueueJobData>;

      await expect(processor.onFailed(job, new Error('transient'))).resolves.toBeUndefined();
      errorSpy.mockRestore();
    });
  });
});
