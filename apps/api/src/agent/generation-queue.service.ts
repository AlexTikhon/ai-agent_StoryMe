import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUES } from '../queue/queues.config';

export interface GenerationQueueJobData {
  bookId: string;
  jobId: string;
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
  constructor(
    @InjectQueue(QUEUES.BOOK_GENERATION) private readonly queue: Queue<GenerationQueueJobData>,
  ) {}

  async enqueue(data: GenerationQueueJobData): Promise<void> {
    await this.queue.add('run-generation', data, { jobId: data.jobId });
  }
}
