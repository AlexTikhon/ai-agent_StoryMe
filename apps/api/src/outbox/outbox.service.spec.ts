import { describe, it, expect, beforeEach } from 'vitest';
import { OutboxService, outboxRetryDelayMs } from './outbox.service';
import { createMockPrisma } from '../common/test-utils/mock-prisma';

type MockPrisma = ReturnType<typeof createMockPrisma>;

describe('OutboxService', () => {
  let prisma: MockPrisma;
  let service: OutboxService;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new OutboxService(prisma as never);
  });

  describe('findPending', () => {
    it('queries only due pending events with deterministic ordering', async () => {
      prisma.outboxEvent.findMany.mockResolvedValue([]);
      const now = new Date('2026-11-05T12:00:00Z');
      await service.findPending(20, now);

      expect(prisma.outboxEvent.findMany).toHaveBeenCalledWith({
        where: { status: 'pending', nextAttemptAt: { lte: now } },
        orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: 20,
      });
    });
  });

  describe('markDispatched', () => {
    it('sets status dispatched and dispatchedAt', async () => {
      prisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });

      await service.markDispatched('event-1');

      expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
        where: { id: 'event-1', status: 'pending' },
        data: { status: 'dispatched', dispatchedAt: expect.any(Date), lastFailureCode: null },
      });
    });
  });

  describe('recordAttemptFailure', () => {
    it('schedules the retry and fences stale attempt snapshots', async () => {
      prisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
      const now = new Date('2026-11-05T12:00:00Z');
      await service.recordAttemptFailure('event-1', 3, now);

      expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
        where: { id: 'event-1', status: 'pending', attempts: 3 },
        data: {
          attempts: { increment: 1 },
          nextAttemptAt: new Date(now.getTime() + 16_000),
          lastFailureCode: 'dispatch_failed',
        },
      });
    });
  });

  it('caps retry delays without exhausting durable work', () => {
    expect([0, 1, 7, 8, 1000].map(outboxRetryDelayMs)).toEqual([
      2000, 4000, 256_000, 300_000, 300_000,
    ]);
  });

  it('quarantines only pending events and stores a fixed reason without payload data', async () => {
    await service.quarantine('event-1', 'invalid_payload');
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'event-1', status: 'pending' },
      data: {
        status: 'quarantined',
        quarantinedAt: expect.any(Date),
        lastFailureCode: 'invalid_payload',
      },
    });
  });
});
