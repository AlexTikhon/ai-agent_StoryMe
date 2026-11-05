import { Injectable } from '@nestjs/common';
import type { OutboxEvent, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

export const OUTBOX_STATUS_PENDING = 'pending';
export const OUTBOX_STATUS_DISPATCHED = 'dispatched';
export const OUTBOX_STATUS_QUARANTINED = 'quarantined';
export type OutboxQuarantineReason = 'unknown_aggregate' | 'invalid_payload';

/** Unlimited transport retries, with a bounded delay; never discard durable work on a Redis outage. */
export function outboxRetryDelayMs(previousAttempts: number): number {
  return Math.min(300_000, 2_000 * 2 ** Math.min(8, Math.max(0, previousAttempts)));
}
/** Phase G1: terminal status for an outbox event suppressed by a cancellation before it was ever dispatched — never describes an event that was actually published to BullMQ (see GenerationRunCoordinator.cancelGeneration). */
export const OUTBOX_STATUS_CANCELLED = 'cancelled';

/**
 * Thin read/write wrapper around OutboxEvent — write-side creation happens
 * inline inside BooksService's run-creation transaction (via `tx.outboxEvent`
 * directly, since it must share that transaction), so this service only
 * covers what the dispatcher needs: finding pending events and recording the
 * outcome of a publish attempt.
 */
@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService) {}

  findPending(limit: number, now = new Date()): Promise<OutboxEvent[]> {
    return this.prisma.outboxEvent.findMany({
      where: { status: OUTBOX_STATUS_PENDING, nextAttemptAt: { lte: now } },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  }

  markDispatched(id: string): Promise<Prisma.BatchPayload> {
    return this.prisma.outboxEvent.updateMany({
      where: { id, status: OUTBOX_STATUS_PENDING },
      data: { status: OUTBOX_STATUS_DISPATCHED, dispatchedAt: new Date(), lastFailureCode: null },
    });
  }

  /** A stale concurrent sweep cannot postpone a newer retry or overwrite a terminal status. */
  recordAttemptFailure(
    id: string,
    previousAttempts = 0,
    now = new Date(),
  ): Promise<Prisma.BatchPayload> {
    return this.prisma.outboxEvent.updateMany({
      where: { id, status: OUTBOX_STATUS_PENDING, attempts: previousAttempts },
      data: {
        attempts: { increment: 1 },
        nextAttemptAt: new Date(now.getTime() + outboxRetryDelayMs(previousAttempts)),
        lastFailureCode: 'dispatch_failed',
      },
    });
  }

  quarantine(id: string, reason: OutboxQuarantineReason): Promise<Prisma.BatchPayload> {
    return this.prisma.outboxEvent.updateMany({
      where: { id, status: OUTBOX_STATUS_PENDING },
      data: {
        status: OUTBOX_STATUS_QUARANTINED,
        quarantinedAt: new Date(),
        lastFailureCode: reason,
      },
    });
  }
}
