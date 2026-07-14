import { Injectable } from '@nestjs/common';
import type { OutboxEvent } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

export const OUTBOX_STATUS_PENDING = 'pending';
export const OUTBOX_STATUS_DISPATCHED = 'dispatched';

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

  findPending(limit: number): Promise<OutboxEvent[]> {
    return this.prisma.outboxEvent.findMany({
      where: { status: OUTBOX_STATUS_PENDING },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  markDispatched(id: string): Promise<OutboxEvent> {
    return this.prisma.outboxEvent.update({
      where: { id },
      data: { status: OUTBOX_STATUS_DISPATCHED, dispatchedAt: new Date() },
    });
  }

  /** Publish attempt failed (e.g. Redis unreachable) — stays pending so the next sweep retries it; only the attempt counter advances. */
  recordAttemptFailure(id: string): Promise<OutboxEvent> {
    return this.prisma.outboxEvent.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
  }
}
