import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { GenerationRun } from '@prisma/client';
import { GenerationRunService } from './generation-run.service';
import { createMockPrisma } from '../common/test-utils/mock-prisma';

type MockPrisma = ReturnType<typeof createMockPrisma>;

function makeGenerationRun(overrides: Partial<GenerationRun> = {}): GenerationRun {
  return {
    id: 'run-1',
    bookId: 'b-1',
    userId: 'u-1',
    kind: 'initial' as GenerationRun['kind'],
    status: 'queued' as GenerationRun['status'],
    inputSnapshot: {},
    inputHash: 'hash-1',
    retryOfRunId: null,
    currentStep: null,
    attempt: 1,
    leaseOwner: null,
    leaseExpiresAt: null,
    leaseAttempt: 0,
    fencingVersion: 0,
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('GenerationRunService', () => {
  let prisma: MockPrisma;
  let service: GenerationRunService;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new GenerationRunService(prisma as never);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  describe('findActiveForBook', () => {
    it('queries for queued or running runs for the book, newest first', async () => {
      prisma.generationRun.findFirst.mockResolvedValue(null);

      await service.findActiveForBook('b-1');

      expect(prisma.generationRun.findFirst).toHaveBeenCalledWith({
        where: { bookId: 'b-1', status: { in: ['queued', 'running'] } },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('findLatestForBook', () => {
    it('queries for any run for the book, newest first', async () => {
      prisma.generationRun.findFirst.mockResolvedValue(null);

      await service.findLatestForBook('b-1');

      expect(prisma.generationRun.findFirst).toHaveBeenCalledWith({
        where: { bookId: 'b-1' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('countActiveForUser', () => {
    it('counts queued or running runs for the user, across every book', async () => {
      prisma.generationRun.count.mockResolvedValue(1);

      const result = await service.countActiveForUser('u-1');

      expect(prisma.generationRun.count).toHaveBeenCalledWith({
        where: { userId: 'u-1', status: { in: ['queued', 'running'] } },
      });
      expect(result).toBe(1);
    });
  });

  describe('countCreatedForUserSince', () => {
    it('counts runs created for the user at or after the given timestamp', async () => {
      prisma.generationRun.count.mockResolvedValue(4);
      const since = new Date('2026-01-01T00:00:00.000Z');

      const result = await service.countCreatedForUserSince('u-1', since);

      expect(prisma.generationRun.count).toHaveBeenCalledWith({
        where: { userId: 'u-1', createdAt: { gte: since } },
      });
      expect(result).toBe(4);
    });
  });

  describe('claim', () => {
    it('atomically claims a queued run: sets running/leaseOwner/leaseExpiresAt/leaseAttempt and increments fencingVersion', async () => {
      prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });
      prisma.generationRun.findUnique.mockResolvedValue(
        makeGenerationRun({
          status: 'running' as GenerationRun['status'],
          fencingVersion: 1,
          leaseOwner: 'worker-a',
        }),
      );

      const result = await service.claim('run-1', 'worker-a', 60_000, 1);

      expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'run-1',
          status: { in: ['queued', 'running'] },
          OR: [
            { leaseOwner: null },
            { leaseOwner: 'worker-a' },
            { leaseExpiresAt: { lt: new Date('2026-01-01T00:00:00.000Z') } },
            { leaseAttempt: { lt: 1 } },
          ],
        },
        data: {
          status: 'running',
          leaseOwner: 'worker-a',
          leaseExpiresAt: new Date('2026-01-01T00:01:00.000Z'),
          leaseAttempt: 1,
          startedAt: new Date('2026-01-01T00:00:00.000Z'),
          fencingVersion: { increment: 1 },
        },
      });
      expect(result?.leaseOwner).toBe('worker-a');
    });

    it('returns null (never throws) when the run is already terminal or leased elsewhere — updateMany matches zero rows', async () => {
      prisma.generationRun.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.claim('run-1', 'worker-a', 60_000, 1);

      expect(result).toBeNull();
      expect(prisma.generationRun.findUnique).not.toHaveBeenCalled();
    });

    it('lets the same worker re-claim its own still-live lease (a BullMQ retry landing on the same process)', async () => {
      prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });
      prisma.generationRun.findUnique.mockResolvedValue(
        makeGenerationRun({ status: 'running' as GenerationRun['status'], leaseOwner: 'worker-a' }),
      );

      const result = await service.claim('run-1', 'worker-a', 60_000, 2);

      expect(result).not.toBeNull();
    });

    it('lets a strictly-higher BullMQ attempt reclaim from a different worker even though the lease has not wall-clock-expired (correct redelivery ownership)', async () => {
      prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });
      prisma.generationRun.findUnique.mockResolvedValue(
        makeGenerationRun({
          status: 'running' as GenerationRun['status'],
          leaseOwner: 'worker-b',
          leaseAttempt: 2,
        }),
      );

      const result = await service.claim('run-1', 'worker-b', 60_000, 3);

      expect(prisma.generationRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([{ leaseAttempt: { lt: 3 } }]),
          }),
        }),
      );
      expect(result).not.toBeNull();
    });
  });

  describe('heartbeat', () => {
    it('extends the lease when fencingVersion and leaseOwner still match', async () => {
      prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.heartbeat('run-1', 'worker-a', 3, 60_000);

      expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
        where: { id: 'run-1', status: 'running', leaseOwner: 'worker-a', fencingVersion: 3 },
        data: { leaseExpiresAt: new Date('2026-01-01T00:01:00.000Z') },
      });
      expect(result).toBe(true);
    });

    it('is a no-op (returns false) once a newer claim has superseded this attempt', async () => {
      prisma.generationRun.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.heartbeat('run-1', 'worker-a', 3, 60_000);

      expect(result).toBe(false);
    });
  });
});
