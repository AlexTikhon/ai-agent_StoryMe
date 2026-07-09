import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUES } from '../queue/queues.config';

export interface GenerationQueueJobData {
  bookId: string;
  jobId: string;
}

/**
 * Safe, non-secret view of the book-generation queue's health — lets
 * diagnostics distinguish "nothing is wrong, the job just hasn't been picked
 * up yet" from "a job is queued but no worker process is running to consume
 * it" (the exact failure mode this was added to make visible — see
 * "Worker process separation" in apps/api/docs/local-generation-pipeline.md).
 */
export interface QueueDiagnostics {
  queueName: string;
  /** Number of BullMQ Worker processes currently connected to this queue (any process, not just this one). */
  workerCount: number;
  counts: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
}

/**
 * Durable BullMQ-backed replacement for the old in-process GenerationTaskRunner
 * (Phase 3H). One BullMQ job per GenerationJob row (Phase 3I) — `jobId` is
 * used as the BullMQ job id, which is already unique per generation attempt,
 * so no separate de-duplication logic is needed here: GenerationJobService's
 * `findActive` check plus BooksService's atomic status claim are still what
 * prevent two concurrent attempts for the same book (see
 * "Generation jobs (Phase 3I)" in docs/local-generation-pipeline.md).
 */
@Injectable()
export class GenerationQueueService {
  private readonly logger = new Logger(GenerationQueueService.name);

  constructor(
    @InjectQueue(QUEUES.BOOK_GENERATION) private readonly queue: Queue<GenerationQueueJobData>,
  ) {}

  async enqueue(data: GenerationQueueJobData): Promise<void> {
    this.logger.log(`Enqueuing generation job — bookId=${data.bookId} jobId=${data.jobId}`);
    await this.queue.add('run-generation', data, { jobId: data.jobId });
  }

  /** Non-secret queue health for GET /:id/generation-diagnostics — see QueueDiagnostics. */
  async getQueueDiagnostics(): Promise<QueueDiagnostics> {
    const [counts, workers] = await Promise.all([
      this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      this.queue.getWorkers(),
    ]);
    return {
      queueName: QUEUES.BOOK_GENERATION,
      workerCount: workers.length,
      counts: {
        waiting: counts['waiting'] ?? 0,
        active: counts['active'] ?? 0,
        completed: counts['completed'] ?? 0,
        failed: counts['failed'] ?? 0,
        delayed: counts['delayed'] ?? 0,
      },
    };
  }
}
