import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { QUEUES } from '../queue/queues.config';
import { BooksService } from '../books/books.service';
import { GenerationRunService, readGenerationRunLeaseMs } from './generation-run.service';
import { InvalidGenerationInputSnapshotError } from './generation-input-snapshot';
import { GenerationInputSnapshotBackfillService } from './generation-input-snapshot-backfill.service';
import {
  GenerationRunCoordinator,
  GenerationRunMirrorInvariantError,
} from './generation-run-coordinator.service';
import type { GenerationExecutionContext } from './generation-execution-context';
import type {
  BookWorkQueueJobData,
  GenerationQueueJobData,
  PageImageRevisionQueueJobData,
} from './generation-queue.service';
import { BookPageImageRevisionService } from '../books/book-page-image-revision.service';
import { correlationFields } from '../common/correlation/correlation-context';

/** Safe, public-facing message for a run whose stored input_snapshot is permanently malformed — never the raw Zod issue list. */
const INVALID_SNAPSHOT_PUBLIC_MESSAGE =
  "This book's saved generation request is invalid and cannot be processed. Please start a new book, or contact support if this persists.";

/**
 * Worker side of the durable generation queue. BullMQ's Worker is created by
 * the `@Processor` base class as soon as this provider is instantiated, so it
 * only runs where `BooksModule.register` wires it in — the dedicated worker
 * process (`worker.ts`, `ENABLE_GENERATION_WORKER=true`), not the API
 * process. See "Worker process separation" in
 * `apps/api/docs/local-generation-pipeline.md`.
 *
 * Every job is claimed via GenerationRunService.claim before any pipeline
 * work starts, keyed on this delivery's own BullMQ lock token (`token`,
 * below) rather than its attempt number — a stalled-job redelivery can reuse
 * the same attempt number, but never the same token (see GenerationRunService
 * .claim's own doc comment). A claim that matches zero rows (the run is
 * already terminal) is treated as a normal no-op, not an error. While a claim
 * is held, a heartbeat periodically extends its lease — fenced on this same
 * token plus fencingVersion — so a slow (but genuinely alive) real-generation
 * run is never mistaken for abandoned, and a delivery a newer claim has
 * superseded can never heartbeat.
 */
@Injectable()
@Processor(QUEUES.BOOK_GENERATION)
export class GenerationQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(GenerationQueueProcessor.name);
  /** Stable per-process identity, recorded on GenerationRun.leaseOwner purely for diagnostics — fencing itself is keyed entirely on the per-delivery token (see GenerationRunService.claim). */
  private readonly workerId = randomUUID();

  constructor(
    private readonly booksService: BooksService,
    private readonly generationRunService: GenerationRunService,
    private readonly generationRunCoordinator: GenerationRunCoordinator,
    private readonly snapshotBackfill: GenerationInputSnapshotBackfillService,
    @Optional()
    private readonly pageImageRevisionService?: BookPageImageRevisionService,
  ) {
    super();
  }

  async process(job: Job<BookWorkQueueJobData>, token?: string): Promise<void> {
    if (job.data.kind === 'page_image_revision') {
      return this.processPageImageRevision(job as Job<PageImageRevisionQueueJobData>, token);
    }
    const maxAttempts = job.opts.attempts ?? 1;
    this.logger.log(
      `worker_job_started kind=book_generation bullmqJobId=${job.id} attempt=${job.attemptsMade + 1}/${maxAttempts} ${correlationFields(
        {
          ...(job.data.requestId && { requestId: job.data.requestId }),
          bookId: job.data.bookId,
          runId: job.data.runId,
        },
      )}`,
    );
    if (!token) {
      // BullMQ always supplies a lock token to a real Worker's processor —
      // this would only happen from a misconfigured/non-standard invocation,
      // which must never silently fence on an empty/shared token.
      throw new Error(
        `BullMQ invoked process() without a delivery token for job ${job.id} (run ${job.data.runId}) — refusing to claim without one.`,
      );
    }

    const leaseMs = readGenerationRunLeaseMs();
    const claimed = await this.generationRunService.claim(
      job.data.runId,
      token,
      this.workerId,
      leaseMs,
    );
    if (!claimed) {
      this.logger.warn(
        `Run ${job.data.runId} (book ${job.data.bookId}) could not be claimed — already terminal; treating as a no-op.`,
      );
      return;
    }

    let normalized;
    try {
      normalized = await this.snapshotBackfill.normalize(claimed);
    } catch (err) {
      if (!(err instanceof InvalidGenerationInputSnapshotError)) throw err;
      this.logger.error(
        `Run ${claimed.id} (book ${claimed.bookId}) has a permanently malformed input_snapshot — finalizing as invalid without any BullMQ retry: ${err.message}`,
      );
      const result = await this.generationRunCoordinator.failInvalidSnapshot(
        { runId: claimed.id, bookId: claimed.bookId, fencingVersion: claimed.fencingVersion },
        INVALID_SNAPSHOT_PUBLIC_MESSAGE,
      );
      if (result === 'book_mirror_mismatch') {
        // A broken mirror invariant is not the same permanent, non-retryable
        // condition the invalid snapshot itself is — thrown so BullMQ treats
        // this delivery as failed (retry/backoff, then the exhausted-retries
        // backstop) instead of silently completing it.
        throw new GenerationRunMirrorInvariantError(claimed.id, claimed.bookId);
      }
      return;
    }

    const abortController = new AbortController();
    const ctx: GenerationExecutionContext = {
      runId: claimed.id,
      bookId: claimed.bookId,
      fencingVersion: claimed.fencingVersion,
      // The pair normalize() returns, never claimed.inputHash directly — a
      // migrated legacy run's stored inputHash column can be stale relative
      // to its (just-migrated) inputSnapshot; see
      // GenerationInputSnapshotBackfillService's own doc comment.
      inputHash: normalized.inputHash,
      inputSnapshot: normalized.snapshot,
      signal: abortController.signal,
    };

    const heartbeatIntervalMs = Math.max(1000, Math.floor(leaseMs / 3));
    const heartbeat = setInterval(() => {
      this.generationRunService
        .heartbeat(ctx.runId, token, ctx.fencingVersion, leaseMs)
        .then((stillOwned) => {
          if (!stillOwned && !abortController.signal.aborted) {
            this.logger.warn(
              `Run ${ctx.runId} (book ${ctx.bookId}) heartbeat found it superseded by a newer delivery — signaling cancellation to the running pipeline.`,
            );
            abortController.abort();
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`Heartbeat failed for run ${ctx.runId}: ${message}`);
        });
    }, heartbeatIntervalMs);
    heartbeat.unref?.();

    try {
      await this.booksService.runGenerationPipeline(ctx);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async processPageImageRevision(
    job: Job<PageImageRevisionQueueJobData>,
    token?: string,
  ): Promise<void> {
    const maxAttempts = job.opts.attempts ?? 1;
    this.logger.log(
      `worker_job_started kind=page_image_revision bullmqJobId=${job.id} attempt=${job.attemptsMade + 1}/${maxAttempts} ${correlationFields(
        {
          ...(job.data.requestId && { requestId: job.data.requestId }),
          bookId: job.data.bookId,
          revisionId: job.data.revisionId,
        },
      )}`,
    );
    if (!token) {
      throw new Error(
        `BullMQ invoked page image revision ${job.data.revisionId} without a delivery token.`,
      );
    }
    if (!this.pageImageRevisionService) {
      throw new Error('Page image revision worker service is not registered.');
    }
    const claimed = await this.pageImageRevisionService.claim(job.data.revisionId, token);
    if (!claimed) return;
    await this.pageImageRevisionService.executeClaimed(claimed.id, claimed.fencingVersion);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<BookWorkQueueJobData>): void {
    if (job.data.kind === 'page_image_revision') {
      this.logger.log(
        `worker_job_completed kind=page_image_revision bullmqJobId=${job.id} ${correlationFields({
          ...(job.data.requestId && { requestId: job.data.requestId }),
          bookId: job.data.bookId,
          revisionId: job.data.revisionId,
        })}`,
      );
      return;
    }
    this.logger.log(
      `worker_job_completed kind=book_generation bullmqJobId=${job.id} ${correlationFields({
        ...(job.data.requestId && { requestId: job.data.requestId }),
        bookId: job.data.bookId,
        runId: job.data.runId,
      })}`,
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
  async onFailed(job: Job<BookWorkQueueJobData> | undefined, error: Error): Promise<void> {
    this.logger.error(
      `worker_job_failed bullmqJobId=${job?.id} attemptsMade=${job?.attemptsMade} errorName=${error.name} ${correlationFields(
        {
          ...(job?.data.requestId && { requestId: job.data.requestId }),
          ...(job?.data.bookId && { bookId: job.data.bookId }),
          ...(job?.data.kind === 'page_image_revision'
            ? { revisionId: job.data.revisionId }
            : job
              ? { runId: job.data.runId }
              : {}),
        },
      )}`,
    );
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return;

    if (job.data.kind === 'page_image_revision') {
      const revisionId = job.data.revisionId;
      await this.pageImageRevisionService?.failAndRefund(revisionId).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to finalize page image revision ${revisionId}: ${message}`);
      });
      return;
    }

    const runId = (job.data as GenerationQueueJobData).runId;
    await this.booksService
      .markRunPermanentlyFailedAfterExhaustedRetries(runId)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to finalize exhausted run ${runId}: ${message}`);
      });
  }
}
