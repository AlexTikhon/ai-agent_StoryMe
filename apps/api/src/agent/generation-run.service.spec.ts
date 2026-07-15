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
    deliveryToken: null,
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
    it('atomically claims a queued run: sets running/leaseOwner/deliveryToken/leaseExpiresAt and increments fencingVersion', async () => {
      prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });
      prisma.generationRun.findUnique.mockResolvedValue(
        makeGenerationRun({
          status: 'running' as GenerationRun['status'],
          fencingVersion: 1,
          leaseOwner: 'worker-a',
          deliveryToken: 'token-1',
        }),
      );

      const result = await service.claim('run-1', 'token-1', 'worker-a', 60_000);

      expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'run-1',
          status: { in: ['queued', 'running'] },
        },
        data: {
          status: 'running',
          leaseOwner: 'worker-a',
          deliveryToken: 'token-1',
          leaseExpiresAt: new Date('2026-01-01T00:01:00.000Z'),
          startedAt: new Date('2026-01-01T00:00:00.000Z'),
          fencingVersion: { increment: 1 },
        },
      });
      expect(result?.deliveryToken).toBe('token-1');
    });

    it('returns null (never throws) when the run is already terminal — updateMany matches zero rows', async () => {
      prisma.generationRun.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.claim('run-1', 'token-1', 'worker-a', 60_000);

      expect(result).toBeNull();
      expect(prisma.generationRun.findUnique).not.toHaveBeenCalled();
    });

    it('succeeds unconditionally (no OR-clause gate) for a run that is still queued/running, regardless of whether the same or a different worker/token held it before — every claim() call represents BullMQ itself asserting it holds the lock right now', async () => {
      prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });
      prisma.generationRun.findUnique.mockResolvedValue(
        makeGenerationRun({ status: 'running' as GenerationRun['status'], leaseOwner: 'worker-a' }),
      );

      const result = await service.claim('run-1', 'token-2', 'worker-a', 60_000);

      expect(result).not.toBeNull();
    });

    it('a redelivery to a different worker/token (e.g. a stalled-job redelivery BullMQ issues without incrementing attemptsMade) always reclaims, replacing the previous delivery owner/token', async () => {
      prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });
      prisma.generationRun.findUnique.mockResolvedValue(
        makeGenerationRun({
          status: 'running' as GenerationRun['status'],
          leaseOwner: 'worker-b',
          deliveryToken: 'token-b',
        }),
      );

      const result = await service.claim('run-1', 'token-b', 'worker-b', 60_000);

      expect(prisma.generationRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ leaseOwner: 'worker-b', deliveryToken: 'token-b' }),
        }),
      );
      expect(result).not.toBeNull();
    });
  });

  describe('heartbeat', () => {
    it('extends the lease when deliveryToken and fencingVersion still match', async () => {
      prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.heartbeat('run-1', 'token-1', 3, 60_000);

      expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
        where: { id: 'run-1', status: 'running', deliveryToken: 'token-1', fencingVersion: 3 },
        data: { leaseExpiresAt: new Date('2026-01-01T00:01:00.000Z') },
      });
      expect(result).toBe(true);
    });

    it('is a no-op (returns false) once a newer claim has superseded this attempt — a stale delivery token can never heartbeat', async () => {
      prisma.generationRun.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.heartbeat('run-1', 'token-1', 3, 60_000);

      expect(result).toBe(false);
    });
  });
});
