import { describe, it, expect, beforeEach } from 'vitest';
import { OutboxService } from './outbox.service';
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
    it('queries for pending events, oldest first, up to the given limit', async () => {
      prisma.outboxEvent.findMany.mockResolvedValue([]);

      await service.findPending(20);

      expect(prisma.outboxEvent.findMany).toHaveBeenCalledWith({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });
    });
  });

  describe('markDispatched', () => {
    it('sets status dispatched and dispatchedAt', async () => {
      prisma.outboxEvent.update.mockResolvedValue({ id: 'event-1' });

      await service.markDispatched('event-1');

      expect(prisma.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: 'event-1' },
        data: { status: 'dispatched', dispatchedAt: expect.any(Date) },
      });
    });
  });

  describe('recordAttemptFailure', () => {
    it('increments the attempts counter and leaves status untouched (stays pending for the next sweep)', async () => {
      prisma.outboxEvent.update.mockResolvedValue({ id: 'event-1' });

      await service.recordAttemptFailure('event-1');

      expect(prisma.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: 'event-1' },
        data: { attempts: { increment: 1 } },
      });
    });
  });
});
