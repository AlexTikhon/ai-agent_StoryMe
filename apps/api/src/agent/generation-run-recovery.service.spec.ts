import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { GenerationRun } from '@prisma/client';
import {
  GenerationRunRecoveryService,
  DEFAULT_GENERATION_RUN_QUEUED_STALE_MS,
  readGenerationRunQueuedStaleMs,
  readGenerationRunRecoveryIntervalMs,
} from './generation-run-recovery.service';
import { GENERATION_INTERRUPTED_MESSAGE } from './generation-job-recovery.service';
import type { GenerationQueueService } from './generation-queue.service';
import { createMockPrisma } from '../common/test-utils/mock-prisma';

type MockPrisma = ReturnType<typeof createMockPrisma>;

function makeGenerationRun(overrides: Partial<GenerationRun> = {}): GenerationRun {
  return {
    id: 'run-1',
    bookId: 'b-1',
    userId: 'u-1',
    kind: 'initial' as GenerationRun['kind'],
    status: 'running' as GenerationRun['status'],
    inputSnapshot: {},
    inputHash: 'hash-1',
    retryOfRunId: null,
    currentStep: null,
    attempt: 1,
    leaseOwner: 'worker-a',
    leaseExpiresAt: new Date('2026-01-01T00:00:00.000Z'),
    leaseAttempt: 1,
    fencingVersion: 2,
    errorCode: null,
    errorMessage: null,
    startedAt: new Date('2025-12-31T23:00:00.000Z'),
    completedAt: null,
    failedAt: null,
    createdAt: new Date('2025-12-31T23:00:00.000Z'),
    updatedAt: new Date('2025-12-31T23:30:00.000Z'),
    ...overrides,
  };
}

function createMockGenerationQueueService(isPending = false): jest.Mocked<GenerationQueueService> {
  return {
    isJobStillPending: vi.fn().mockResolvedValue(isPending),
  } as unknown as jest.Mocked<GenerationQueueService>;
}

describe('readGenerationRunQueuedStaleMs / readGenerationRunRecoveryIntervalMs', () => {
  it('fall back to their defaults for missing/malformed values', () => {
    expect(readGenerationRunQueuedStaleMs({})).toBe(DEFAULT_GENERATION_RUN_QUEUED_STALE_MS);
    expect(readGenerationRunQueuedStaleMs({ GENERATION_RUN_QUEUED_STALE_MS: 'nope' })).toBe(
      DEFAULT_GENERATION_RUN_QUEUED_STALE_MS,
    );
    expect(
      readGenerationRunRecoveryIntervalMs({ GENERATION_RUN_RECOVERY_INTERVAL_MS: '-1' }),
    ).toBeGreaterThan(0);
  });

  it('parses a valid positive value', () => {
    expect(readGenerationRunQueuedStaleMs({ GENERATION_RUN_QUEUED_STALE_MS: '12345' })).toBe(12345);
  });
});

describe('GenerationRunRecoveryService', () => {
  let prisma: MockPrisma;
  let generationQueueService: jest.Mocked<GenerationQueueService>;
  let service: GenerationRunRecoveryService;
  const now = new Date('2026-01-01T01:00:00.000Z');

  beforeEach(() => {
    prisma = createMockPrisma();
    generationQueueService = createMockGenerationQueueService(false);
    service = new GenerationRunRecoveryService(prisma as never, generationQueueService as never);
    prisma.$transaction.mockImplementation((cb: (tx: MockPrisma) => unknown) => cb(prisma));
    // Lease acquired by default; individual tests override for the "lease busy" case.
    prisma.recoveryLease.updateMany.mockResolvedValue({ count: 1 });
    prisma.generationRun.findMany.mockResolvedValue([]);
    prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.book.updateMany.mockResolvedValue({ count: 1 });
  });

  it('skips the whole pass (no queries, no writes) when the recovery lease is already held elsewhere', async () => {
    prisma.recoveryLease.updateMany.mockResolvedValueOnce({ count: 0 });

    const summary = await service.recover(now);

    expect(summary).toEqual({
      staleFound: 0,
      recovered: 0,
      stillPendingInBullMq: 0,
      errors: 0,
      lockSkipped: true,
    });
    expect(prisma.generationRun.findMany).not.toHaveBeenCalled();
  });

  it('always releases the recovery lease, even when a run fails to recover', async () => {
    const run = makeGenerationRun();
    prisma.generationRun.findMany.mockResolvedValueOnce([run]).mockResolvedValueOnce([]);
    generationQueueService.isJobStillPending.mockRejectedValue(new Error('redis blip'));

    await service.recover(now);

    // Second call is the release — first is the acquire.
    expect(prisma.recoveryLease.updateMany).toHaveBeenCalledTimes(2);
  });

  it('queries stale running runs by leaseExpiresAt (never bare updatedAt) and stale queued runs by createdAt cutoff', async () => {
    prisma.generationRun.findMany.mockResolvedValue([]);

    await service.recover(now);

    expect(prisma.generationRun.findMany).toHaveBeenCalledWith({
      where: { status: 'running', leaseExpiresAt: { lt: now } },
    });
    expect(prisma.generationRun.findMany).toHaveBeenCalledWith({
      where: {
        status: 'queued',
        createdAt: { lt: new Date(now.getTime() - DEFAULT_GENERATION_RUN_QUEUED_STALE_MS) },
      },
    });
  });

  it('leaves a run alone (no DB write) when BullMQ still reports its job as pending', async () => {
    const run = makeGenerationRun();
    prisma.generationRun.findMany.mockResolvedValueOnce([run]).mockResolvedValueOnce([]);
    generationQueueService.isJobStillPending.mockResolvedValue(true);

    const summary = await service.recover(now);

    expect(prisma.generationRun.updateMany).not.toHaveBeenCalled();
    expect(prisma.book.updateMany).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ staleFound: 1, recovered: 0, stillPendingInBullMq: 1 });
  });

  it('fails a run (fenced) and clears Book.activeRunId when BullMQ no longer has its job pending', async () => {
    const run = makeGenerationRun({
      id: 'run-1',
      bookId: 'b-1',
      status: 'running' as GenerationRun['status'],
      fencingVersion: 2,
    });
    prisma.generationRun.findMany.mockResolvedValueOnce([run]).mockResolvedValueOnce([]);
    generationQueueService.isJobStillPending.mockResolvedValue(false);

    const summary = await service.recover(now);

    expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', status: 'running', fencingVersion: 2 },
      data: {
        status: 'failed',
        failedAt: expect.any(Date),
        errorCode: 'GENERATION_ABANDONED',
        errorMessage: GENERATION_INTERRUPTED_MESSAGE,
      },
    });
    expect(prisma.book.updateMany).toHaveBeenCalledWith({
      where: { id: 'b-1', activeRunId: 'run-1' },
      data: {
        activeRunId: null,
        status: 'failed',
        failedStep: null,
        errorMessage: GENERATION_INTERRUPTED_MESSAGE,
      },
    });
    expect(summary).toMatchObject({ recovered: 1 });
  });

  it('does not touch Book when the fencing guard finds the run already moved on (updateMany matches 0 rows)', async () => {
    const run = makeGenerationRun();
    prisma.generationRun.findMany.mockResolvedValueOnce([run]).mockResolvedValueOnce([]);
    generationQueueService.isJobStillPending.mockResolvedValue(false);
    prisma.generationRun.updateMany.mockResolvedValue({ count: 0 });

    await service.recover(now);

    expect(prisma.book.updateMany).not.toHaveBeenCalled();
  });

  it('continues past one run erroring and reports the error count', async () => {
    const runA = makeGenerationRun({ id: 'run-a', bookId: 'book-a' });
    const runB = makeGenerationRun({ id: 'run-b', bookId: 'book-b' });
    prisma.generationRun.findMany.mockResolvedValueOnce([runA, runB]).mockResolvedValueOnce([]);
    generationQueueService.isJobStillPending
      .mockRejectedValueOnce(new Error('redis blip'))
      .mockResolvedValueOnce(false);

    const summary = await service.recover(now);

    expect(summary).toMatchObject({ staleFound: 2, recovered: 1, errors: 1 });
  });

  describe('onApplicationBootstrap', () => {
    it('runs one recovery pass immediately and never throws even if it rejects', async () => {
      prisma.recoveryLease.updateMany.mockRejectedValue(new Error('connection refused'));

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();

      service.onModuleDestroy();
    });
  });
});
