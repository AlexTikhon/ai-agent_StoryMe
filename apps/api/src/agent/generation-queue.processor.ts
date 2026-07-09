import { Injectable, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUEUES } from '../queue/queues.config';
import { BooksService } from '../books/books.service';
import type { GenerationQueueJobData } from './generation-queue.service';

/**
 * Worker side of the durable generation queue (Phase 3K). BullMQ's Worker is
 * created by the `@Processor` base class as soon as this provider is
 * instantiated, so it only runs where `BooksModule.register` wires it in —
 * the dedicated worker process (`worker.ts`, `ENABLE_GENERATION_WORKER=true`),
 * not the API process. See "Worker process separation" in
 * `apps/api/docs/local-generation-pipeline.md`.
 *
 * `BooksService.runGenerationPipeline` never throws (see its own doc
 * comment) — this process() method is expected to always resolve, so
 * BullMQ's built-in attempt/backoff retry (see DEFAULT_JOB_OPTIONS in
 * queue.module.ts) never actually triggers for this queue; retries are
 * instead the user-driven retry-generation flow (Phase 3G).
 */
@Injectable()
@Processor(QUEUES.BOOK_GENERATION)
export class GenerationQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(GenerationQueueProcessor.name);

  constructor(private readonly booksService: BooksService) {
    super();
  }

  async process(job: Job<GenerationQueueJobData>): Promise<void> {
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    this.logger.log(
      `Picked up job — bullmqJobId=${job.id} bookId=${job.data.bookId} generationJobId=${job.data.jobId} attempt=${attempt}/${maxAttempts}`,
    );
    await this.booksService.runGenerationPipeline(job.data.bookId, job.data.jobId);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<GenerationQueueJobData>): void {
    this.logger.log(
      `Job completed — bullmqJobId=${job.id} bookId=${job.data.bookId} generationJobId=${job.data.jobId}`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<GenerationQueueJobData> | undefined, error: Error): void {
    this.logger.error(
      `Job failed — bullmqJobId=${job?.id} bookId=${job?.data.bookId} generationJobId=${job?.data.jobId} attemptsMade=${job?.attemptsMade} error=${error.name}: ${error.message}`,
      error.stack,
    );
  }
}
