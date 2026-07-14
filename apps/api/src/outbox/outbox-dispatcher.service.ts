import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { OutboxEvent } from '@prisma/client';
import { GenerationQueueService } from '../agent/generation-queue.service';
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
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Outbox sweep failed unexpectedly: ${message}`);
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
    if (event.aggregateType !== 'generation_run') {
      this.logger.warn(`Skipping outbox event ${event.id} with unknown aggregateType "${event.aggregateType}".`);
      return;
    }
    const payload = event.payload as { bookId?: unknown; runId?: unknown };
    if (typeof payload.bookId !== 'string' || typeof payload.runId !== 'string') {
      this.logger.error(`Outbox event ${event.id} has a malformed payload — skipping without dispatching.`);
      return;
    }
    try {
      await this.generationQueueService.enqueue({ bookId: payload.bookId, runId: payload.runId });
      await this.outboxService.markDispatched(event.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to dispatch outbox event ${event.id} (run ${payload.runId}): ${message}`);
      await this.outboxService.recordAttemptFailure(event.id).catch(() => undefined);
    }
  }
}
