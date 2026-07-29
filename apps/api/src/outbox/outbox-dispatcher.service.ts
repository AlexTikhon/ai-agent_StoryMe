import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { OutboxEvent } from '@prisma/client';
import { GenerationQueueService } from '../agent/generation-queue.service';
import { correlationFields, isRequestId } from '../common/correlation/correlation-context';
import { OutboxService } from './outbox.service';

export const DEFAULT_OUTBOX_DISPATCH_INTERVAL_MS = 2_000;
export const DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE = 20;

/** Reads OUTBOX_DISPATCH_INTERVAL_MS from env, falling back to a safe default when missing or malformed. */
export function readOutboxDispatchIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['OUTBOX_DISPATCH_INTERVAL_MS'];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_OUTBOX_DISPATCH_INTERVAL_MS;
}

/** Reads OUTBOX_DISPATCH_BATCH_SIZE from env, falling back to a safe default when missing or malformed. */
export function readOutboxDispatchBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['OUTBOX_DISPATCH_BATCH_SIZE'];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_OUTBOX_DISPATCH_BATCH_SIZE;
}

/**
 * Periodic sweep that publishes every still-`pending` OutboxEvent to BullMQ.
 * This — not BooksService calling GenerationQueueService directly — is what
 * makes "DB commit followed by process crash cannot permanently lose queue
 * dispatch" true: the event was already committed in the same transaction as
 * the GenerationRun and Book update, so a crash between that commit and the
 * BullMQ publish just leaves the event `pending` for the next sweep (in this
 * process after restart, or any other live process) to pick up.
 *
 * Safe to run in every process (API and worker both register this) — a
 * `runId`-keyed BullMQ jobId (see GenerationQueueService.enqueue) makes a
 * duplicate sweep of the same event an idempotent no-op, not a duplicate job.
 */
@Injectable()
export class OutboxDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcherService.name);
  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;

  constructor(
    private readonly outboxService: OutboxService,
    private readonly generationQueueService: GenerationQueueService,
  ) {}

  onModuleInit(): void {
    const intervalMs = readOutboxDispatchIntervalMs();
    this.timer = setInterval(() => {
      this.sweep().catch((err: unknown) => {
        const errorName = err instanceof Error ? err.name : 'UnknownError';
        this.logger.error(`outbox_sweep_failed errorName=${errorName}`);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One sweep pass — exposed directly for tests, rather than only reachable via the interval timer. Never throws. */
  async sweep(): Promise<void> {
    if (this.sweeping) return; // a previous sweep is still running (slow Redis) — don't overlap
    this.sweeping = true;
    try {
      const pending = await this.outboxService.findPending(readOutboxDispatchBatchSize());
      for (const event of pending) {
        await this.dispatchOne(event);
      }
    } finally {
      this.sweeping = false;
    }
  }

  private async dispatchOne(event: OutboxEvent): Promise<void> {
    if (
      event.aggregateType !== 'generation_run' &&
      event.aggregateType !== 'page_image_revision' &&
      event.aggregateType !== 'book_deletion'
    ) {
      this.logger.warn(
        `Skipping outbox event ${event.id} with unknown aggregateType "${event.aggregateType}".`,
      );
      return;
    }
    const payload = event.payload as {
      bookId?: unknown;
      runId?: unknown;
      revisionId?: unknown;
      deletionRequestId?: unknown;
      requestId?: unknown;
    };
    const aggregateId =
      event.aggregateType === 'generation_run'
        ? payload.runId
        : event.aggregateType === 'page_image_revision'
          ? payload.revisionId
          : payload.deletionRequestId;
    if (typeof payload.bookId !== 'string' || typeof aggregateId !== 'string') {
      this.logger.error(
        `Outbox event ${event.id} has a malformed payload — skipping without dispatching.`,
      );
      return;
    }
    const requestId = isRequestId(payload.requestId) ? payload.requestId : undefined;
    try {
      if (event.aggregateType === 'generation_run') {
        await this.generationQueueService.enqueue({
          bookId: payload.bookId,
          runId: aggregateId,
          ...(requestId && { requestId }),
        });
      } else if (event.aggregateType === 'page_image_revision') {
        await this.generationQueueService.enqueuePageImageRevision({
          kind: 'page_image_revision',
          bookId: payload.bookId,
          revisionId: aggregateId,
          ...(requestId && { requestId }),
        });
      } else {
        await this.generationQueueService.enqueueBookDeletion({
          kind: 'book_deletion',
          bookId: payload.bookId,
          deletionRequestId: aggregateId,
          ...(requestId && { requestId }),
        });
      }
      await this.outboxService.markDispatched(event.id);
      this.logger.log(
        `outbox_dispatched eventId=${event.id} aggregateType=${event.aggregateType} ${correlationFields(
          {
            ...(requestId && { requestId }),
            bookId: payload.bookId,
            ...(event.aggregateType === 'generation_run'
              ? { runId: aggregateId }
              : event.aggregateType === 'page_image_revision'
                ? { revisionId: aggregateId }
                : { deletionRequestId: aggregateId }),
          },
        )}`,
      );
    } catch (err) {
      const errorName = err instanceof Error ? err.name : 'UnknownError';
      this.logger.error(
        `outbox_dispatch_failed eventId=${event.id} aggregateType=${event.aggregateType} errorName=${errorName} ${correlationFields(
          {
            ...(requestId && { requestId }),
            bookId: payload.bookId,
            ...(event.aggregateType === 'generation_run'
              ? { runId: aggregateId }
              : event.aggregateType === 'page_image_revision'
                ? { revisionId: aggregateId }
                : { deletionRequestId: aggregateId }),
          },
        )}`,
      );
      await this.outboxService.recordAttemptFailure(event.id).catch(() => undefined);
    }
  }
}
