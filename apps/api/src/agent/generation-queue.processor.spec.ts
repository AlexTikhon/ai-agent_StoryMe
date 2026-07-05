import { describe, it, expect, vi } from 'vitest';
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
});
