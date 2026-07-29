import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { GenerationRun } from '@prisma/client';
import { GenerationQueueProcessor } from './generation-queue.processor';
import type { BooksService } from '../books/books.service';
import type { GenerationRunService } from './generation-run.service';
import {
  GenerationRunMirrorInvariantError,
  type GenerationRunCoordinator,
} from './generation-run-coordinator.service';
import type { GenerationInputSnapshotBackfillService } from './generation-input-snapshot-backfill.service';
import { parseGenerationInputSnapshot } from './generation-input-snapshot';
import type { GenerationExecutionContext } from './generation-execution-context';
import type { BookWorkQueueJobData, GenerationQueueJobData } from './generation-queue.service';
import type { BookPageImageRevisionService } from '../books/book-page-image-revision.service';

/** The BullMQ per-delivery lock token process(job, token) receives — see GenerationRunService.claim's doc comment for why this, not attemptsMade, is the fencing identity. */
const TOKEN = 'delivery-token-1';

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
    deliveryToken: 'delivery-token-1',
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

function createMockGenerationRunCoordinator(): jest.Mocked<GenerationRunCoordinator> {
  return {
    completeRun: vi.fn().mockResolvedValue('applied'),
    failInvalidSnapshot: vi.fn().mockResolvedValue('applied'),
  } as unknown as jest.Mocked<GenerationRunCoordinator>;
}

/** Default: delegates to the real (pure, no-I/O) parseGenerationInputSnapshot, paired with the run's own inputHash — legacy-migration itself is covered by generation-input-snapshot-backfill.service.spec.ts. */
function createMockSnapshotBackfillService(): jest.Mocked<GenerationInputSnapshotBackfillService> {
  return {
    normalize: vi.fn((run: { id: string; inputSnapshot: unknown; inputHash: string }) =>
      Promise.resolve({
        snapshot: parseGenerationInputSnapshot(run.id, run.inputSnapshot),
        inputHash: run.inputHash,
      }),
    ),
  } as unknown as jest.Mocked<GenerationInputSnapshotBackfillService>;
}

function createMockPageImageRevisionService(): jest.Mocked<BookPageImageRevisionService> {
  return {
    claim: vi.fn().mockResolvedValue({ id: 'revision-1', fencingVersion: 2 }),
    executeClaimed: vi.fn().mockResolvedValue(undefined),
    failAndRefund: vi.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<BookPageImageRevisionService>;
}

describe('GenerationQueueProcessor', () => {
  describe('process', () => {
    it('executes a durable hard-delete request through the deletion service', async () => {
      const deletionService = { process: vi.fn().mockResolvedValue(undefined) };
      const processor = new GenerationQueueProcessor(
        createMockBooksService() as never,
        createMockGenerationRunService() as never,
        createMockGenerationRunCoordinator() as never,
        createMockSnapshotBackfillService() as never,
        createMockPageImageRevisionService(),
        deletionService as never,
      );
      const job = {
        data: {
          kind: 'book_deletion',
          bookId: 'b-1',
          deletionRequestId: 'deletion-1',
        },
        attemptsMade: 0,
        opts: { attempts: 8 },
      } as unknown as Job<BookWorkQueueJobData>;

      await processor.process(job);

      expect(deletionService.process).toHaveBeenCalledWith('deletion-1');
    });

    it('claims and executes a durable page-image revision through its own fenced path', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const pageRevisionService = createMockPageImageRevisionService();
      const processor = new GenerationQueueProcessor(
        createMockBooksService() as never,
        createMockGenerationRunService() as never,
        createMockGenerationRunCoordinator() as never,
        createMockSnapshotBackfillService() as never,
        pageRevisionService,
      );
      const job = {
        data: {
          kind: 'page_image_revision',
          bookId: 'b-1',
          revisionId: 'revision-1',
          requestId: '77777777-7777-4777-8777-777777777777',
        },
        attemptsMade: 0,
        opts: { attempts: 1 },
      } as unknown as Job<GenerationQueueJobData>;

      await processor.process(job as never, TOKEN);

      expect(pageRevisionService.claim).toHaveBeenCalledWith('revision-1', TOKEN);
      expect(pageRevisionService.executeClaimed).toHaveBeenCalledWith('revision-1', 2);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'requestId=77777777-7777-4777-8777-777777777777 bookId=b-1 revisionId=revision-1',
        ),
      );
      logSpy.mockRestore();
    });
    it('claims the run before delegating to BooksService.runGenerationPipeline', async () => {
      const booksService = createMockBooksService();
      const claimed = makeGenerationRun();
      const generationRunService = createMockGenerationRunService(claimed);
      const generationRunCoordinator = createMockGenerationRunCoordinator();
      const snapshotBackfill = createMockSnapshotBackfillService();
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
        generationRunCoordinator as never,
        snapshotBackfill as never,
      );

      await processor.process(makeJob({ bookId: 'b-1', runId: 'run-1' }), TOKEN);

      expect(generationRunService.claim).toHaveBeenCalledWith(
        'run-1',
        TOKEN,
        expect.any(String),
        expect.any(Number),
      );
      expect(booksService.runGenerationPipeline).toHaveBeenCalledWith({
        runId: claimed.id,
        bookId: claimed.bookId,
        fencingVersion: claimed.fencingVersion,
        inputHash: claimed.inputHash,
        inputSnapshot: VALID_SNAPSHOT,
        signal: expect.any(AbortSignal),
      });
    });

    it('is a no-op (does not call runGenerationPipeline) when the claim fails — already terminal or leased elsewhere', async () => {
      const booksService = createMockBooksService();
      const generationRunService = createMockGenerationRunService(null);
      const generationRunCoordinator = createMockGenerationRunCoordinator();
      const snapshotBackfill = createMockSnapshotBackfillService();
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
        generationRunCoordinator as never,
        snapshotBackfill as never,
      );

      await expect(
        processor.process(makeJob({ bookId: 'b-1', runId: 'run-1' }), TOKEN),
      ).resolves.toBeUndefined();

      expect(booksService.runGenerationPipeline).not.toHaveBeenCalled();
    });

    it('propagates a rejection from runGenerationPipeline (an unexpected/transient failure BullMQ should retry)', async () => {
      const booksService = createMockBooksService();
      booksService.runGenerationPipeline.mockRejectedValue(new Error('unexpected'));
      const generationRunService = createMockGenerationRunService();
      const generationRunCoordinator = createMockGenerationRunCoordinator();
      const snapshotBackfill = createMockSnapshotBackfillService();
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
        generationRunCoordinator as never,
        snapshotBackfill as never,
      );

      await expect(
        processor.process(makeJob({ bookId: 'b-1', runId: 'run-1' }), TOKEN),
      ).rejects.toThrow('unexpected');
    });

    it('throws (and never claims) when BullMQ invokes process() without a delivery token', async () => {
      const booksService = createMockBooksService();
      const generationRunService = createMockGenerationRunService();
      const generationRunCoordinator = createMockGenerationRunCoordinator();
      const snapshotBackfill = createMockSnapshotBackfillService();
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
        generationRunCoordinator as never,
        snapshotBackfill as never,
      );

      await expect(processor.process(makeJob({ bookId: 'b-1', runId: 'run-1' }))).rejects.toThrow(
        'without a delivery token',
      );
      expect(generationRunService.claim).not.toHaveBeenCalled();
    });

    it('logs the BullMQ job id, bookId, and runId when picking up a job', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const booksService = createMockBooksService();
      const generationRunService = createMockGenerationRunService();
      const generationRunCoordinator = createMockGenerationRunCoordinator();
      const snapshotBackfill = createMockSnapshotBackfillService();
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
        generationRunCoordinator as never,
        snapshotBackfill as never,
      );
      const job = {
        ...makeJob({
          bookId: 'b-1',
          runId: 'run-1',
          requestId: '66666666-6666-4666-8666-666666666666',
        }),
        id: 'bullmq-42',
      } as Job<GenerationQueueJobData>;

      await processor.process(job, TOKEN);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'bullmqJobId=bullmq-42 attempt=1/3 requestId=66666666-6666-4666-8666-666666666666 bookId=b-1 runId=run-1',
        ),
      );
      logSpy.mockRestore();
    });

    it('aborts ctx.signal via the periodic heartbeat once it discovers a newer delivery already owns the run', async () => {
      vi.useFakeTimers();
      try {
        const booksService = createMockBooksService();
        let capturedCtx: GenerationExecutionContext | undefined;
        let resolvePipeline: () => void = () => undefined;
        booksService.runGenerationPipeline.mockImplementation((ctx: GenerationExecutionContext) => {
          capturedCtx = ctx;
          return new Promise<void>((resolve) => {
            resolvePipeline = resolve;
          });
        });
        const claimed = makeGenerationRun();
        const generationRunService = createMockGenerationRunService(claimed);
        generationRunService.heartbeat.mockResolvedValue(false);
        const generationRunCoordinator = createMockGenerationRunCoordinator();
        const snapshotBackfill = createMockSnapshotBackfillService();
        const processor = new GenerationQueueProcessor(
          booksService as never,
          generationRunService as never,
          generationRunCoordinator as never,
          snapshotBackfill as never,
        );

        const processPromise = processor.process(makeJob({ bookId: 'b-1', runId: 'run-1' }), TOKEN);
        // Let process() reach runGenerationPipeline before advancing timers.
        await vi.waitFor(() => expect(capturedCtx).toBeDefined());
        expect(capturedCtx?.signal?.aborted).toBe(false);

        // Advance past the heartbeat interval (leaseMs/3, default 10 minutes).
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

        expect(capturedCtx?.signal?.aborted).toBe(true);
        resolvePipeline();
        await processPromise;
      } finally {
        vi.useRealTimers();
      }
    });

    it('finalizes a permanently malformed input_snapshot via the coordinator, without ever calling runGenerationPipeline or rethrowing (so BullMQ never retries it)', async () => {
      const booksService = createMockBooksService();
      const claimed = makeGenerationRun({ inputSnapshot: { not: 'a valid snapshot' } });
      const generationRunService = createMockGenerationRunService(claimed);
      const generationRunCoordinator = createMockGenerationRunCoordinator();
      const snapshotBackfill = createMockSnapshotBackfillService();
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
        generationRunCoordinator as never,
        snapshotBackfill as never,
      );

      await expect(
        processor.process(makeJob({ bookId: 'b-1', runId: 'run-1' }), TOKEN),
      ).resolves.toBeUndefined();

      expect(booksService.runGenerationPipeline).not.toHaveBeenCalled();
      expect(generationRunCoordinator.failInvalidSnapshot).toHaveBeenCalledWith(
        { runId: claimed.id, bookId: claimed.bookId, fencingVersion: claimed.fencingVersion },
        expect.any(String),
      );
      // Never the raw Zod issue list — a stable, safe public message.
      const [, publicMessage] = generationRunCoordinator.failInvalidSnapshot.mock.calls[0]!;
      expect(publicMessage).not.toContain('ZodError');
      expect(publicMessage).not.toContain('not: ');
    });

    it('throws GenerationRunMirrorInvariantError (so BullMQ retries rather than treating the delivery as completed) when failInvalidSnapshot reports a book_mirror_mismatch', async () => {
      const booksService = createMockBooksService();
      const claimed = makeGenerationRun({ inputSnapshot: { not: 'a valid snapshot' } });
      const generationRunService = createMockGenerationRunService(claimed);
      const generationRunCoordinator = createMockGenerationRunCoordinator();
      generationRunCoordinator.failInvalidSnapshot.mockResolvedValue('book_mirror_mismatch');
      const snapshotBackfill = createMockSnapshotBackfillService();
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
        generationRunCoordinator as never,
        snapshotBackfill as never,
      );

      await expect(
        processor.process(makeJob({ bookId: 'b-1', runId: 'run-1' }), TOKEN),
      ).rejects.toBeInstanceOf(GenerationRunMirrorInvariantError);
    });

    it('logs the stable GENERATION_INPUT_SNAPSHOT_INVALID code when finalizing a malformed snapshot', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const booksService = createMockBooksService();
      const claimed = makeGenerationRun({ inputSnapshot: null });
      const generationRunService = createMockGenerationRunService(claimed);
      const generationRunCoordinator = createMockGenerationRunCoordinator();
      const snapshotBackfill = createMockSnapshotBackfillService();
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
        generationRunCoordinator as never,
        snapshotBackfill as never,
      );

      await processor.process(makeJob({ bookId: 'b-1', runId: 'run-1' }), TOKEN);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`permanently malformed input_snapshot`),
      );
      errorSpy.mockRestore();
    });
  });

  it('logs on the completed worker event', () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const booksService = createMockBooksService();
    const generationRunService = createMockGenerationRunService();
    const generationRunCoordinator = createMockGenerationRunCoordinator();
    const snapshotBackfill = createMockSnapshotBackfillService();
    const processor = new GenerationQueueProcessor(
      booksService as never,
      generationRunService as never,
      generationRunCoordinator as never,
      snapshotBackfill as never,
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
    it('refunds a failed one-call page-image job instead of finalizing a GenerationRun', async () => {
      const booksService = createMockBooksService();
      const pageRevisionService = createMockPageImageRevisionService();
      const processor = new GenerationQueueProcessor(
        booksService as never,
        createMockGenerationRunService() as never,
        createMockGenerationRunCoordinator() as never,
        createMockSnapshotBackfillService() as never,
        pageRevisionService,
      );
      const job = {
        data: {
          kind: 'page_image_revision',
          bookId: 'b-1',
          revisionId: 'revision-1',
        },
        attemptsMade: 1,
        opts: { attempts: 1 },
      } as never;

      await processor.onFailed(job, new Error('provider failed'));

      expect(pageRevisionService.failAndRefund).toHaveBeenCalledWith('revision-1');
      expect(booksService.markRunPermanentlyFailedAfterExhaustedRetries).not.toHaveBeenCalled();
    });
    it('logs a safe error message without throwing on an undefined job', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const booksService = createMockBooksService();
      const generationRunService = createMockGenerationRunService();
      const generationRunCoordinator = createMockGenerationRunCoordinator();
      const snapshotBackfill = createMockSnapshotBackfillService();
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
        generationRunCoordinator as never,
        snapshotBackfill as never,
      );

      await processor.onFailed(undefined, new Error('Redis connection refused'));

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('errorName=Error'));
      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Redis connection refused'),
      );
      errorSpy.mockRestore();
    });

    it('does not finalize the run when more BullMQ attempts remain', async () => {
      const booksService = createMockBooksService();
      const generationRunService = createMockGenerationRunService();
      const generationRunCoordinator = createMockGenerationRunCoordinator();
      const snapshotBackfill = createMockSnapshotBackfillService();
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
        generationRunCoordinator as never,
        snapshotBackfill as never,
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
      const generationRunCoordinator = createMockGenerationRunCoordinator();
      const snapshotBackfill = createMockSnapshotBackfillService();
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
        generationRunCoordinator as never,
        snapshotBackfill as never,
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
      const generationRunCoordinator = createMockGenerationRunCoordinator();
      const snapshotBackfill = createMockSnapshotBackfillService();
      const processor = new GenerationQueueProcessor(
        booksService as never,
        generationRunService as never,
        generationRunCoordinator as never,
        snapshotBackfill as never,
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
