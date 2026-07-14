import { Injectable, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { QUEUES } from '../queue/queues.config';
import { BooksService } from '../books/books.service';
import { GenerationRunService, readGenerationRunLeaseMs } from './generation-run.service';
import type { GenerationQueueJobData } from './generation-queue.service';

/**
 * Worker side of the durable generation queue. BullMQ's Worker is created by
 * the `@Processor` base class as soon as this provider is instantiated, so it
 * only runs where `BooksModule.register` wires it in — the dedicated worker
 * process (`worker.ts`, `ENABLE_GENERATION_WORKER=true`), not the API
 * process. See "Worker process separation" in
 * `apps/api/docs/local-generation-pipeline.md`.
 *
 * Every job is claimed via GenerationRunService.claim before any pipeline
 * work starts — a claim that matches zero rows (the run is already
 * terminal, or another live worker already holds its lease) is treated as a
 * normal no-op, not an error, since it means there is genuinely nothing left
 * for this delivery to do (see "Generation runs" in
 * docs/local-generation-pipeline.md).
 */
@Injectable()
@Processor(QUEUES.BOOK_GENERATION)
export class GenerationQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(GenerationQueueProcessor.name);
  /** Stable per-process identity for lease ownership — lets a BullMQ retry landing on this same process re-claim its own still-live lease (see GenerationRunService.claim). */
  private readonly workerId = randomUUID();

  constructor(
    private readonly booksService: BooksService,
    private readonly generationRunService: GenerationRunService,
  ) {
    super();
  }

  async process(job: Job<GenerationQueueJobData>): Promise<void> {
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    this.logger.log(
      `Picked up job — bullmqJobId=${job.id} bookId=${job.data.bookId} runId=${job.data.runId} attempt=${attempt}/${maxAttempts}`,
    );

    const claimed = await this.generationRunService.claim(
      job.data.runId,
      this.workerId,
      readGenerationRunLeaseMs(),
    );
    if (!claimed) {
      this.logger.warn(
        `Run ${job.data.runId} (book ${job.data.bookId}) could not be claimed — already terminal or leased elsewhere; treating as a no-op.`,
      );
      return;
    }

    await this.booksService.runGenerationPipeline(job.data.bookId, claimed);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<GenerationQueueJobData>): void {
    this.logger.log(
      `Job completed — bullmqJobId=${job.id} bookId=${job.data.bookId} runId=${job.data.runId}`,
    );
  }

  /**
   * BullMQ's own attempts/backoff (see DEFAULT_JOB_OPTIONS, queue.module.ts)
   * retries a run that threw an unexpected/transient error (see
   * BooksService.runGenerationPipeline) without this handler doing anything —
   * only once every attempt is exhausted does this step in and finalize the
   * run/book as failed, so a book can never be left stuck in a non-terminal
   * status indefinitely just because retries ran out. Phase 2C's recovery
   * sweep is the backstop for this same scenario when a whole process (not
   * just one job) dies mid-attempt.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<GenerationQueueJobData> | undefined, error: Error): Promise<void> {
    this.logger.error(
      `Job failed — bullmqJobId=${job?.id} bookId=${job?.data.bookId} runId=${job?.data.runId} attemptsMade=${job?.attemptsMade} error=${error.name}: ${error.message}`,
      error.stack,
    );
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return;

    await this.booksService
      .markRunPermanentlyFailedAfterExhaustedRetries(job.data.runId)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to finalize exhausted run ${job.data.runId}: ${message}`);
      });
  }
}
