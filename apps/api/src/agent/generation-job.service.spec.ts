import { describe, it, expect, beforeEach } from 'vitest';
import { GenerationJobService } from './generation-job.service';
import { createMockPrisma } from '../common/test-utils/mock-prisma';

type MockPrisma = ReturnType<typeof createMockPrisma>;

describe('GenerationJobService', () => {
  let prisma: MockPrisma;
  let service: GenerationJobService;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new GenerationJobService(prisma as never);
  });

  describe('findActive', () => {
    it('queries for queued or running jobs for the book, newest first', async () => {
      prisma.generationJob.findFirst.mockResolvedValue(null);

      await service.findActive('b-1');

      expect(prisma.generationJob.findFirst).toHaveBeenCalledWith({
        where: { bookId: 'b-1', status: { in: ['queued', 'running'] } },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('findLatest', () => {
    it('queries for any job for the book, newest first', async () => {
      prisma.generationJob.findFirst.mockResolvedValue(null);

      await service.findLatest('b-1');

      expect(prisma.generationJob.findFirst).toHaveBeenCalledWith({
        where: { bookId: 'b-1' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('createQueued', () => {
    it('creates a job with status queued and the given type/attempt', async () => {
      prisma.generationJob.create.mockResolvedValue({ id: 'job-1' });

      await service.createQueued({ bookId: 'b-1', userId: 'u-1', type: 'generate', attempt: 1 });

      expect(prisma.generationJob.create).toHaveBeenCalledWith({
        data: { bookId: 'b-1', userId: 'u-1', type: 'generate', attempt: 1, status: 'queued' },
      });
    });
  });

  describe('markRunning', () => {
    it('sets status running and startedAt', async () => {
      prisma.generationJob.update.mockResolvedValue({ id: 'job-1' });

      await service.markRunning('job-1');

      expect(prisma.generationJob.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { status: 'running', startedAt: expect.any(Date) },
      });
    });
  });

  describe('markCompleted', () => {
    it('sets status completed and completedAt', async () => {
      prisma.generationJob.update.mockResolvedValue({ id: 'job-1' });

      await service.markCompleted('job-1');

      expect(prisma.generationJob.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { status: 'completed', completedAt: expect.any(Date) },
      });
    });
  });

  describe('markFailed', () => {
    it('sets status failed, failedAt, errorMessage, and failedStep', async () => {
      prisma.generationJob.update.mockResolvedValue({ id: 'job-1' });

      await service.markFailed('job-1', { errorMessage: 'boom', failedStep: 'image_gen' as never });

      expect(prisma.generationJob.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: {
          status: 'failed',
          failedAt: expect.any(Date),
          errorMessage: 'boom',
          failedStep: 'image_gen',
        },
      });
    });

    it('defaults failedStep to null when not provided', async () => {
      prisma.generationJob.update.mockResolvedValue({ id: 'job-1' });

      await service.markFailed('job-1', { errorMessage: 'boom' });

      expect(prisma.generationJob.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ failedStep: null }) }),
      );
    });
  });
});
