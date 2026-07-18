import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUES } from '../queue/queues.config';

export interface GenerationQueueJobData {
  bookId: string;
  /** GenerationRun.id — also used as the BullMQ jobId, so a re-dispatch of the same run (e.g. a re-swept outbox event) is a no-op rather than a duplicate job. */
  runId: string;
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
 * Durable BullMQ-backed dispatch for the book-generation pipeline. One BullMQ
 * job per GenerationRun (Phase 2A/2B) — `runId` is used as the BullMQ job id,
 * which is already unique per generation attempt and lets a re-dispatch of
 * the same run (e.g. OutboxDispatcherService re-sweeping a `pending` event
 * after a crash) land as an idempotent no-op instead of a duplicate job. Only
 * ever called by OutboxDispatcherService now — BooksService creates the
 * GenerationRun/OutboxEvent transactionally and never calls this directly, so
 * a crash between "commit the run" and "publish to BullMQ" can never
 * permanently lose the dispatch (see "Generation runs" in
 * docs/local-generation-pipeline.md).
 */
@Injectable()
export class GenerationQueueService {
  private readonly logger = new Logger(GenerationQueueService.name);

  constructor(
    @InjectQueue(QUEUES.BOOK_GENERATION) private readonly queue: Queue<GenerationQueueJobData>,
  ) {}

  async enqueue(data: GenerationQueueJobData): Promise<void> {
    this.logger.log(`Enqueuing generation run — bookId=${data.bookId} runId=${data.runId}`);
    await this.queue.add('run-generation', data, { jobId: data.runId });
  }

  /**
   * True when BullMQ still considers `runId`'s job pending in some form —
   * active, waiting, delayed, or failed-with-more-attempts-still-to-come.
   * False when the job is missing entirely, or failed with every attempt
   * already exhausted. GenerationRunRecoveryService uses this so a run whose
   * DB lease looks expired but whose BullMQ job is still legitimately
   * in-flight is never force-failed based on DB age alone (invariant F in
   * docs/local-generation-pipeline.md) — a `completed` job is deliberately
   * NOT treated as "still pending" (false) either: by construction, a run
   * whose job actually reached BullMQ's `completed` state can only get there
   * after BooksService.completeRun already finished, at which point the run
   * itself is no longer `queued`/`running` and would never have been a
   * recovery candidate in the first place — so `false` here is the safe,
   * conservative answer in every case recovery can actually observe it.
   */
  async isJobStillPending(runId: string): Promise<boolean> {
    const job = await this.queue.getJob(runId);
    if (!job) return false;
    const state = await job.getState();
    if (state === 'completed') return false;
    if (state === 'failed') {
      const maxAttempts = job.opts.attempts ?? 1;
      return job.attemptsMade < maxAttempts;
    }
    return true;
  }

  /**
   * Phase G1: best-effort BullMQ cleanup for a run whose cancellation has
   * ALREADY been committed to Postgres by GenerationRunCoordinator
   * .cancelGeneration — this method is never the correctness mechanism for
   * cancellation, only tidying. A `waiting`/`delayed`/`prioritized` job
   * (never yet picked up by a worker) is safely removed outright. An
   * `active` job is left alone — BullMQ has no safe way to yank a lock out
   * from under a worker mid-processing, so pretending to force-remove it
   * would either throw or silently no-op; the worker's own heartbeat/
   * AbortSignal check (GenerationRunService.heartbeat fencing on the
   * now-cancelled status) is what actually stops it, independent of Redis.
   * A missing job (already completed/removed, or the outbox never actually
   * dispatched it) and any removal failure are both logged and swallowed —
   * neither can undo or fail the already-committed cancellation.
   */
  async removeIfSafe(runId: string): Promise<void> {
    try {
      const job = await this.queue.getJob(runId);
      if (!job) {
        this.logger.log(`No BullMQ job found for cancelled run ${runId} — nothing to remove.`);
        return;
      }
      const state = await job.getState();
      if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
        await job.remove();
        this.logger.log(`Removed BullMQ job for cancelled run ${runId} (state was "${state}").`);
      } else {
        this.logger.log(
          `BullMQ job for cancelled run ${runId} is "${state}" — leaving it alone; the committed DB cancellation/fencing, not queue removal, is what stops it from publishing an outcome.`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Best-effort BullMQ cleanup failed for cancelled run ${runId}: ${message}`);
    }
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
