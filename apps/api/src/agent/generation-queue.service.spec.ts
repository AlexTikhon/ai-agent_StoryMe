import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { GenerationQueueService } from './generation-queue.service';

function createMockQueue(): jest.Mocked<Queue> {
  return {
    add: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn().mockResolvedValue(undefined),
    getJobCounts: vi.fn().mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    }),
    getWorkers: vi.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<Queue>;
}

function makeBullMqJob(state: string, overrides: { attemptsMade?: number; attempts?: number } = {}) {
  return {
    getState: vi.fn().mockResolvedValue(state),
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 3 },
  };
}

describe('GenerationQueueService', () => {
  it('adds one job to the queue with the GenerationRun id as the BullMQ job id', async () => {
    const queue = createMockQueue();
    const service = new GenerationQueueService(queue as never);

    await service.enqueue({ bookId: 'b-1', runId: 'run-1' });

    expect(queue.add).toHaveBeenCalledWith(
      'run-generation',
      { bookId: 'b-1', runId: 'run-1' },
      { jobId: 'run-1' },
    );
  });

  it('propagates a rejection from the underlying queue (e.g. Redis unreachable)', async () => {
    const queue = createMockQueue();
    queue.add.mockRejectedValue(new Error('Redis connection refused'));
    const service = new GenerationQueueService(queue as never);

    await expect(service.enqueue({ bookId: 'b-1', runId: 'run-1' })).rejects.toThrow(
      'Redis connection refused',
    );
  });

  it('logs bookId and runId when enqueuing', async () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const queue = createMockQueue();
    const service = new GenerationQueueService(queue as never);

    await service.enqueue({ bookId: 'b-1', runId: 'run-1' });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('bookId=b-1 runId=run-1'));
    logSpy.mockRestore();
  });

  describe('isJobStillPending', () => {
    it('returns false when the job does not exist in BullMQ at all', async () => {
      const queue = createMockQueue();
      queue.getJob.mockResolvedValue(undefined);
      const service = new GenerationQueueService(queue as never);

      expect(await service.isJobStillPending('run-1')).toBe(false);
    });

    it.each(['active', 'waiting', 'delayed', 'waiting-children', 'prioritized'])(
      'returns true when the job state is "%s"',
      async (state) => {
        const queue = createMockQueue();
        queue.getJob.mockResolvedValue(makeBullMqJob(state) as never);
        const service = new GenerationQueueService(queue as never);

        expect(await service.isJobStillPending('run-1')).toBe(true);
      },
    );

    it('returns false when the job state is "completed"', async () => {
      const queue = createMockQueue();
      queue.getJob.mockResolvedValue(makeBullMqJob('completed') as never);
      const service = new GenerationQueueService(queue as never);

      expect(await service.isJobStillPending('run-1')).toBe(false);
    });

    it('returns true when the job failed but more attempts remain', async () => {
      const queue = createMockQueue();
      queue.getJob.mockResolvedValue(makeBullMqJob('failed', { attemptsMade: 1, attempts: 3 }) as never);
      const service = new GenerationQueueService(queue as never);

      expect(await service.isJobStillPending('run-1')).toBe(true);
    });

    it('returns false when the job failed and every attempt is exhausted', async () => {
      const queue = createMockQueue();
      queue.getJob.mockResolvedValue(makeBullMqJob('failed', { attemptsMade: 3, attempts: 3 }) as never);
      const service = new GenerationQueueService(queue as never);

      expect(await service.isJobStillPending('run-1')).toBe(false);
    });
  });

  describe('getQueueDiagnostics', () => {
    it('returns the queue name, job counts, and connected worker count', async () => {
      const queue = createMockQueue();
      queue.getJobCounts.mockResolvedValue({
        waiting: 2,
        active: 1,
        completed: 10,
        failed: 1,
        delayed: 0,
      });
      queue.getWorkers.mockResolvedValue([{ id: 'w-1' }, { id: 'w-2' }] as never);
      const service = new GenerationQueueService(queue as never);

      const diagnostics = await service.getQueueDiagnostics();

      expect(diagnostics).toEqual({
        queueName: 'book-generation',
        workerCount: 2,
        counts: { waiting: 2, active: 1, completed: 10, failed: 1, delayed: 0 },
      });
    });

    it('reports workerCount: 0 when no worker process is connected (the "queued forever" signature)', async () => {
      const queue = createMockQueue();
      const service = new GenerationQueueService(queue as never);

      const diagnostics = await service.getQueueDiagnostics();

      expect(diagnostics.workerCount).toBe(0);
    });
  });
});
