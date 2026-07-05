import { describe, it, expect, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { GenerationQueueService } from './generation-queue.service';

function createMockQueue(): jest.Mocked<Queue> {
  return { add: vi.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<Queue>;
}

describe('GenerationQueueService', () => {
  it('adds one job to the queue with the GenerationJob id as the BullMQ job id', async () => {
    const queue = createMockQueue();
    const service = new GenerationQueueService(queue as never);

    await service.enqueue({ bookId: 'b-1', jobId: 'job-1' });

    expect(queue.add).toHaveBeenCalledWith(
      'run-generation',
      { bookId: 'b-1', jobId: 'job-1' },
      { jobId: 'job-1' },
    );
  });

  it('propagates a rejection from the underlying queue (e.g. Redis unreachable)', async () => {
    const queue = createMockQueue();
    queue.add.mockRejectedValue(new Error('Redis connection refused'));
    const service = new GenerationQueueService(queue as never);

    await expect(service.enqueue({ bookId: 'b-1', jobId: 'job-1' })).rejects.toThrow(
      'Redis connection refused',
    );
  });
});
