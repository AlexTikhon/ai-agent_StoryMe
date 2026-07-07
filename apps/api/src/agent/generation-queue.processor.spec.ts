import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { GenerationQueueProcessor } from './generation-queue.processor';
import type { BooksService } from '../books/books.service';
import type { GenerationQueueJobData } from './generation-queue.service';

function createMockBooksService(): jest.Mocked<BooksService> {
  return {
    runGenerationPipeline: vi.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<BooksService>;
}

function makeJob(data: GenerationQueueJobData): Job<GenerationQueueJobData> {
  return { data } as Job<GenerationQueueJobData>;
}

describe('GenerationQueueProcessor', () => {
  it('delegates to BooksService.runGenerationPipeline with the job data', async () => {
    const booksService = createMockBooksService();
    const processor = new GenerationQueueProcessor(booksService as never);

    await processor.process(makeJob({ bookId: 'b-1', jobId: 'job-1' }));

    expect(booksService.runGenerationPipeline).toHaveBeenCalledWith('b-1', 'job-1');
  });

  it('propagates a rejection from runGenerationPipeline (should not happen in practice, since it never throws)', async () => {
    const booksService = createMockBooksService();
    booksService.runGenerationPipeline.mockRejectedValue(new Error('unexpected'));
    const processor = new GenerationQueueProcessor(booksService as never);

    await expect(processor.process(makeJob({ bookId: 'b-1', jobId: 'job-1' }))).rejects.toThrow(
      'unexpected',
    );
  });

  it('logs the BullMQ job id, bookId, and generationJobId when picking up a job', async () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const booksService = createMockBooksService();
    const processor = new GenerationQueueProcessor(booksService as never);
    const job = {
      ...makeJob({ bookId: 'b-1', jobId: 'job-1' }),
      id: 'bullmq-42',
    } as Job<GenerationQueueJobData>;

    await processor.process(job);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('bullmqJobId=bullmq-42 bookId=b-1 generationJobId=job-1'),
    );
    logSpy.mockRestore();
  });

  it('logs on the completed worker event', () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const booksService = createMockBooksService();
    const processor = new GenerationQueueProcessor(booksService as never);
    const job = {
      ...makeJob({ bookId: 'b-1', jobId: 'job-1' }),
      id: 'bullmq-42',
    } as Job<GenerationQueueJobData>;

    processor.onCompleted(job);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('bullmqJobId=bullmq-42 bookId=b-1 generationJobId=job-1'),
    );
    logSpy.mockRestore();
  });

  it('logs a safe error message on the failed worker event without throwing on an undefined job', () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const booksService = createMockBooksService();
    const processor = new GenerationQueueProcessor(booksService as never);

    processor.onFailed(undefined, new Error('Redis connection refused'));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('error=Redis connection refused'),
    );
    errorSpy.mockRestore();
  });
});
