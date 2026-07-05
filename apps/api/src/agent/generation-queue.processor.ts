import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUEUES } from '../queue/queues.config';
import { BooksService } from '../books/books.service';
import type { GenerationQueueJobData } from './generation-queue.service';

/**
 * Worker side of the durable generation queue (Phase 3K) — runs in the same
 * process as the API today (BullMQ's Worker is created by the `@Processor`
 * base class as soon as this provider is instantiated). A future phase could
 * move this into a dedicated worker process without changing
 * GenerationQueueService's producer contract.
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
    this.logger.log(`Processing generation job ${job.data.jobId} for book ${job.data.bookId}`);
    await this.booksService.runGenerationPipeline(job.data.bookId, job.data.jobId);
  }
}
