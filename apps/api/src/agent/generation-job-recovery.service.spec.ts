import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { GenerationJob } from '@prisma/client';
import {
  GenerationJobRecoveryService,
  GENERATION_INTERRUPTED_MESSAGE,
  DEFAULT_GENERATION_JOB_STALE_AFTER_MS,
  readGenerationJobStaleAfterMs,
} from './generation-job-recovery.service';
import { GenerationJobService } from './generation-job.service';
import { createMockPrisma } from '../common/test-utils/mock-prisma';

type MockPrisma = ReturnType<typeof createMockPrisma>;

function makeGenerationJob(overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: 'job-1',
    bookId: 'b-1',
    userId: 'u-1',
    type: 'generate' as GenerationJob['type'],
    status: 'queued' as GenerationJob['status'],
    attempt: 1,
    maxAttempts: null,
    failedStep: null,
    errorMessage: null,
    runnerId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('readGenerationJobStaleAfterMs', () => {
  it('defaults to 30 minutes when unset', () => {
    expect(readGenerationJobStaleAfterMs({})).toBe(DEFAULT_GENERATION_JOB_STALE_AFTER_MS);
    expect(DEFAULT_GENERATION_JOB_STALE_AFTER_MS).toBe(1_800_000);
  });

  it('parses a valid positive value from env', () => {
    expect(readGenerationJobStaleAfterMs({ GENERATION_JOB_STALE_AFTER_MS: '60000' })).toBe(60_000);
  });

  it('falls back to the default for malformed or non-positive values', () => {
    expect(readGenerationJobStaleAfterMs({ GENERATION_JOB_STALE_AFTER_MS: 'not-a-number' })).toBe(
      DEFAULT_GENERATION_JOB_STALE_AFTER_MS,
    );
    expect(readGenerationJobStaleAfterMs({ GENERATION_JOB_STALE_AFTER_MS: '-5' })).toBe(
      DEFAULT_GENERATION_JOB_STALE_AFTER_MS,
    );
    expect(readGenerationJobStaleAfterMs({ GENERATION_JOB_STALE_AFTER_MS: '0' })).toBe(
      DEFAULT_GENERATION_JOB_STALE_AFTER_MS,
    );
  });
});

/**
 * This service only cleans up the legacy GenerationJob diagnostics mirror
 * now — it must never touch Book (see the service's own doc comment for
 * why: GenerationRunRecoveryService is the sole authority for Book.status
 * during recovery since Phase 2C, and it checks BullMQ before acting).
 */
describe('GenerationJobRecoveryService', () => {
  let prisma: MockPrisma;
  let generationJobService: GenerationJobService;
  let service: GenerationJobRecoveryService;
  const now = new Date('2026-07-02T12:00:00.000Z');

  beforeEach(() => {
    prisma = createMockPrisma();
    generationJobService = new GenerationJobService(prisma as never);
    service = new GenerationJobRecoveryService(generationJobService);
  });

  it('marks a stale queued job failed with a safe error message', async () => {
    const job = makeGenerationJob({ status: 'queued' as GenerationJob['status'] });
    prisma.generationJob.findMany.mockResolvedValue([job]);
    prisma.generationJob.update.mockResolvedValue({ ...job, status: 'failed' });

    const summary = await service.recover(DEFAULT_GENERATION_JOB_STALE_AFTER_MS, now);

    expect(prisma.generationJob.update).toHaveBeenCalledWith({
      where: { id: job.id },
      data: expect.objectContaining({
        status: 'failed',
        errorMessage: GENERATION_INTERRUPTED_MESSAGE,
        failedStep: null,
      }),
    });
    expect(summary).toEqual({ staleJobsFound: 1, jobsRecovered: 1, errors: 0 });
  });

  it('marks a stale running job failed with a safe error message', async () => {
    const job = makeGenerationJob({
      status: 'running' as GenerationJob['status'],
      startedAt: new Date('2026-07-02T11:00:00.000Z'),
    });
    prisma.generationJob.findMany.mockResolvedValue([job]);
    prisma.generationJob.update.mockResolvedValue({ ...job, status: 'failed' });

    await service.recover(DEFAULT_GENERATION_JOB_STALE_AFTER_MS, now);

    expect(prisma.generationJob.update).toHaveBeenCalledWith({
      where: { id: job.id },
      data: expect.objectContaining({
        status: 'failed',
        errorMessage: GENERATION_INTERRUPTED_MESSAGE,
      }),
    });
  });

  it('never touches Book — GenerationRunRecoveryService owns that now', async () => {
    const job = makeGenerationJob();
    prisma.generationJob.findMany.mockResolvedValue([job]);
    prisma.generationJob.update.mockResolvedValue({ ...job, status: 'failed' });

    await service.recover(DEFAULT_GENERATION_JOB_STALE_AFTER_MS, now);

    expect(prisma.book.update).not.toHaveBeenCalled();
    expect(prisma.book.updateMany).not.toHaveBeenCalled();
    expect(prisma.book.findUnique).not.toHaveBeenCalled();
  });

  it('does not recover fresh queued/running jobs (delegates cutoff filtering to findStaleActiveJobs)', async () => {
    prisma.generationJob.findMany.mockResolvedValue([]);

    const summary = await service.recover(DEFAULT_GENERATION_JOB_STALE_AFTER_MS, now);

    expect(prisma.generationJob.findMany).toHaveBeenCalledWith({
      where: {
        status: { in: ['queued', 'running'] },
        updatedAt: { lt: new Date(now.getTime() - DEFAULT_GENERATION_JOB_STALE_AFTER_MS) },
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(summary).toEqual({ staleJobsFound: 0, jobsRecovered: 0, errors: 0 });
  });

  it('continues recovering remaining jobs and reports a count when one job fails to recover', async () => {
    const jobA = makeGenerationJob({ id: 'job-a', bookId: 'book-a' });
    const jobB = makeGenerationJob({ id: 'job-b', bookId: 'book-b' });
    prisma.generationJob.findMany.mockResolvedValue([jobA, jobB]);
    prisma.generationJob.update
      .mockRejectedValueOnce(new Error('db unavailable'))
      .mockResolvedValueOnce({ ...jobB, status: 'failed' });

    const summary = await service.recover(DEFAULT_GENERATION_JOB_STALE_AFTER_MS, now);

    expect(summary).toEqual({ staleJobsFound: 2, jobsRecovered: 1, errors: 1 });
  });

  it('onApplicationBootstrap logs a summary and never throws, even if recovery itself rejects', async () => {
    prisma.generationJob.findMany.mockRejectedValue(new Error('connection refused'));

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('onApplicationBootstrap runs recovery using the configured stale threshold', async () => {
    prisma.generationJob.findMany.mockResolvedValue([]);
    const recoverSpy = vi.spyOn(service, 'recover');

    await service.onApplicationBootstrap();

    expect(recoverSpy).toHaveBeenCalledWith(DEFAULT_GENERATION_JOB_STALE_AFTER_MS);
  });
});
