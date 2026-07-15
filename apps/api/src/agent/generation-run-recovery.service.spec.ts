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
import type { GenerationRunCoordinator } from './generation-run-coordinator.service';
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
    deliveryToken: 'token-a',
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

function createMockGenerationRunCoordinator(): jest.Mocked<GenerationRunCoordinator> {
  return {
    failAbandoned: vi.fn().mockResolvedValue('applied'),
  } as unknown as jest.Mocked<GenerationRunCoordinator>;
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

/** `strings` is the tagged-template literal's TemplateStringsArray — join it to sniff which raw query this is without depending on exact whitespace. */
function sqlOf(strings: unknown): string {
  return Array.isArray(strings) ? strings.join('') : String(strings);
}

describe('GenerationRunRecoveryService', () => {
  let prisma: MockPrisma;
  let generationQueueService: jest.Mocked<GenerationQueueService>;
  let generationRunCoordinator: jest.Mocked<GenerationRunCoordinator>;
  let service: GenerationRunRecoveryService;
  const now = new Date('2026-01-01T01:00:00.000Z');
  let leaseHeld: boolean;
  let leaseGeneration: number;

  beforeEach(() => {
    prisma = createMockPrisma();
    generationQueueService = createMockGenerationQueueService(false);
    generationRunCoordinator = createMockGenerationRunCoordinator();
    service = new GenerationRunRecoveryService(
      prisma as never,
      generationQueueService as never,
      generationRunCoordinator as never,
    );
    prisma.$transaction.mockImplementation((cb: (tx: MockPrisma) => unknown) => cb(prisma));
    // Lease acquired by default; individual tests override for the "lease busy" / "lost mid-pass" cases.
    leaseHeld = true;
    leaseGeneration = 7;
    prisma.$queryRaw.mockImplementation((strings: unknown) => {
      const sql = sqlOf(strings);
      if (sql.includes('RETURNING lease_generation')) {
        return Promise.resolve(leaseHeld ? [{ lease_generation: leaseGeneration }] : []);
      }
      if (sql.includes('SELECT 1 AS ok')) {
        return Promise.resolve(leaseHeld ? [{ ok: 1 }] : []);
      }
      return Promise.resolve([]);
    });
    prisma.recoveryLease.updateMany.mockResolvedValue({ count: 1 });
    prisma.generationRun.findMany.mockResolvedValue([]);
    prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.book.updateMany.mockResolvedValue({ count: 1 });
  });

  it('skips the whole pass (no queries, no writes) when the recovery lease is already held elsewhere', async () => {
    leaseHeld = false;

    const summary = await service.recover(now);

    expect(summary).toEqual({
      staleFound: 0,
      recovered: 0,
      stillPendingInBullMq: 0,
      staleFenceLost: 0,
      mirrorMismatch: 0,
      errors: 0,
      lockSkipped: true,
    });
    expect(prisma.generationRun.findMany).not.toHaveBeenCalled();
  });

  it('acquires the lease using PostgreSQL server time (NOW()) for both the expiry comparison and the new expiry, never an application Date', async () => {
    await service.recover(now);

    const acquireCall = prisma.$queryRaw.mock.calls.find((call) =>
      sqlOf(call[0]).includes('RETURNING lease_generation'),
    );
    expect(acquireCall).toBeDefined();
    const sql = sqlOf(acquireCall![0]);
    expect(sql).toContain('NOW()');
    // Every interpolated value is a plain string/number (instanceId, leaseMs,
    // the fixed lease id) — never a `new Date()` standing in for "now".
    expect(acquireCall!.slice(1).every((value) => !(value instanceof Date))).toBe(true);
  });

  it('always releases the recovery lease (fenced on the generation it acquired), even when a run fails to recover', async () => {
    const run = makeGenerationRun();
    prisma.generationRun.findMany.mockResolvedValueOnce([run]).mockResolvedValueOnce([]);
    generationQueueService.isJobStillPending.mockRejectedValue(new Error('redis blip'));

    await service.recover(now);

    expect(prisma.recoveryLease.updateMany).toHaveBeenCalledWith({
      where: { id: 'generation_run_recovery', leaseOwner: expect.any(String), leaseGeneration: 7 },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
  });

  it('stops processing further candidates (bounded batch) the moment stillHoldsLease reports leadership was lost, without erroring', async () => {
    const runA = makeGenerationRun({ id: 'run-a', bookId: 'book-a' });
    const runB = makeGenerationRun({ id: 'run-b', bookId: 'book-b' });
    prisma.generationRun.findMany.mockResolvedValueOnce([runA, runB]).mockResolvedValueOnce([]);
    generationQueueService.isJobStillPending.mockResolvedValue(false);
    // Leadership is lost between processing runA and checking before runB.
    let stillHoldsCalls = 0;
    prisma.$queryRaw.mockImplementation((strings: unknown) => {
      const sql = sqlOf(strings);
      if (sql.includes('RETURNING lease_generation')) {
        return Promise.resolve([{ lease_generation: leaseGeneration }]);
      }
      if (sql.includes('SELECT 1 AS ok')) {
        stillHoldsCalls += 1;
        return Promise.resolve(stillHoldsCalls === 1 ? [{ ok: 1 }] : []);
      }
      return Promise.resolve([]);
    });

    const summary = await service.recover(now);

    expect(summary.staleFound).toBe(2);
    expect(summary.recovered).toBe(1); // only runA was processed
    expect(generationQueueService.isJobStillPending).toHaveBeenCalledTimes(1);
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

  it('finalizes a stale run via GenerationRunCoordinator.failAbandoned (fenced on its own status/fencingVersion) when BullMQ no longer has its job pending', async () => {
    const run = makeGenerationRun({
      id: 'run-1',
      bookId: 'b-1',
      status: 'running' as GenerationRun['status'],
      fencingVersion: 2,
    });
    prisma.generationRun.findMany.mockResolvedValueOnce([run]).mockResolvedValueOnce([]);
    generationQueueService.isJobStillPending.mockResolvedValue(false);

    const summary = await service.recover(now);

    expect(generationRunCoordinator.failAbandoned).toHaveBeenCalledWith(
      { runId: 'run-1', bookId: 'b-1', fencingVersion: 2, fromStatus: 'running' },
      { errorCode: 'GENERATION_ABANDONED', errorMessage: GENERATION_INTERRUPTED_MESSAGE },
    );
    expect(summary).toMatchObject({ recovered: 1 });
  });

  it('fences a stale queued (never-claimed) run on fromStatus "queued", not "running"', async () => {
    const run = makeGenerationRun({
      id: 'run-1',
      bookId: 'b-1',
      status: 'queued' as GenerationRun['status'],
      fencingVersion: 0,
    });
    prisma.generationRun.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([run]);
    generationQueueService.isJobStillPending.mockResolvedValue(false);

    await service.recover(now);

    expect(generationRunCoordinator.failAbandoned).toHaveBeenCalledWith(
      expect.objectContaining({ fromStatus: 'queued' }),
      expect.anything(),
    );
  });

  it('counts the run under staleFenceLost (never stillPendingInBullMq or recovered) when the coordinator reports stale_fence — a live claim already moved it on', async () => {
    const run = makeGenerationRun();
    prisma.generationRun.findMany.mockResolvedValueOnce([run]).mockResolvedValueOnce([]);
    generationQueueService.isJobStillPending.mockResolvedValue(false);
    generationRunCoordinator.failAbandoned.mockResolvedValue('stale_fence');

    const summary = await service.recover(now);

    expect(summary).toMatchObject({
      recovered: 0,
      stillPendingInBullMq: 0,
      staleFenceLost: 1,
      mirrorMismatch: 0,
    });
  });

  it('counts the run under mirrorMismatch — never folded into stillPendingInBullMq or staleFenceLost — when the coordinator reports a book_mirror_mismatch, since BullMQ has already reported the job absent', async () => {
    const run = makeGenerationRun();
    prisma.generationRun.findMany.mockResolvedValueOnce([run]).mockResolvedValueOnce([]);
    generationQueueService.isJobStillPending.mockResolvedValue(false);
    generationRunCoordinator.failAbandoned.mockResolvedValue('book_mirror_mismatch');

    const summary = await service.recover(now);

    expect(summary).toMatchObject({
      recovered: 0,
      stillPendingInBullMq: 0,
      staleFenceLost: 0,
      mirrorMismatch: 1,
    });
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
      prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();

      service.onModuleDestroy();
    });
  });
});
