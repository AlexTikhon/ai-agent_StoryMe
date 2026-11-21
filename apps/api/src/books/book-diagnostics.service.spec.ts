import { NotFoundException } from '@nestjs/common';
import { Prisma, type Book, type GenerationRun } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationQueueService } from '../agent/generation-queue.service';
import type { GenerationRunService } from '../agent/generation-run.service';
import { createMockPrisma } from '../common/test-utils/mock-prisma';
import type { PdfStorage } from '../pdf/pdf-storage';
import type { BookCrudService } from './book-crud.service';
import { BookDiagnosticsService, DIAGNOSTICS_RECENT_LOG_LIMIT } from './book-diagnostics.service';

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'book-1',
    userId: 'user-1',
    status: 'char_build',
    pageCount: 10,
    bookPreview: null,
    imageGenerationResult: null,
    aiModelVersions: null,
    generationTimeMs: null,
    failedStep: null,
    errorMessage: null,
    previewPdfUrl: null,
    publishedRunId: null,
    publishedRunFencingVersion: null,
    publishedPdfRunId: null,
    publishedPdfFencingVersion: null,
    childPhotoAssetKey: null,
    characterProfile: null,
    characterSheetAssetKey: null,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as Book;
}

function makeRun(overrides: Partial<GenerationRun> = {}): GenerationRun {
  return {
    id: 'run-1',
    bookId: 'book-1',
    userId: 'user-1',
    kind: 'initial',
    status: 'queued',
    inputSnapshot: {},
    inputHash: 'input-hash',
    retryOfRunId: null,
    currentStep: null,
    attempt: 1,
    leaseOwner: null,
    leaseExpiresAt: null,
    deliveryToken: null,
    fencingVersion: 0,
    errorCode: null,
    errorMessage: null,
    providerOperations: null,
    executionAuthorization: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as GenerationRun;
}

describe('BookDiagnosticsService', () => {
  const prisma = createMockPrisma();
  const crud = {
    findOwnedOrThrow: vi.fn(),
  } as unknown as jest.Mocked<BookCrudService>;
  const runs = {
    findLatestForBook: vi.fn(),
  } as unknown as jest.Mocked<GenerationRunService>;
  const queue = {
    getQueueDiagnostics: vi.fn(),
  } as unknown as jest.Mocked<GenerationQueueService>;
  const pdfStorage = {
    driver: 'local',
    previewPdfExists: vi.fn(),
    claimPreviewPdfExists: vi.fn(),
  } as unknown as jest.Mocked<PdfStorage>;

  let service: BookDiagnosticsService;
  /** Records whether a read happened inside the snapshot transaction. */
  let inSnapshot = false;
  const readsOutsideSnapshot: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    readsOutsideSnapshot.length = 0;
    prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      inSnapshot = true;
      try {
        return await callback(prisma);
      } finally {
        inSnapshot = false;
      }
    });
    const track = (name: string, value: unknown) =>
      vi.fn(async () => {
        if (!inSnapshot) readsOutsideSnapshot.push(name);
        return value;
      });
    prisma.book.findFirst.mockImplementation(track('book', makeBook()));
    prisma.generationRun.findFirst.mockImplementation(track('run', null));
    prisma.agentLog.findMany.mockImplementation(track('logs', []));
    crud.findOwnedOrThrow.mockResolvedValue(makeBook());
    runs.findLatestForBook.mockResolvedValue(null);
    queue.getQueueDiagnostics.mockResolvedValue({
      queueName: 'book-generation',
      workerCount: 1,
      counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
    });
    service = new BookDiagnosticsService(crud, prisma as never, runs, queue, pdfStorage);
  });

  it('stops at the owned-book boundary before reading runs, logs, queue or storage', async () => {
    prisma.book.findFirst.mockResolvedValue(null);

    await expect(service.getGenerationDiagnostics('book-1', 'other-user')).rejects.toThrow(
      NotFoundException,
    );

    expect(prisma.book.findFirst).toHaveBeenCalledWith({
      where: { id: 'book-1', userId: 'other-user', deletedAt: null },
    });
    expect(prisma.generationRun.findFirst).not.toHaveBeenCalled();
    expect(prisma.agentLog.findMany).not.toHaveBeenCalled();
    expect(queue.getQueueDiagnostics).not.toHaveBeenCalled();
    expect(pdfStorage.claimPreviewPdfExists).not.toHaveBeenCalled();
  });

  it('reads all database provenance in one repeatable-read snapshot with owner-scoped, bounded queries', async () => {
    prisma.book.findFirst.mockResolvedValue(
      makeBook({
        status: 'failed',
        previewPdfUrl: '/files/books/book-1/runs/run-a/claims/1/storyme-preview-book-1.pdf',
        publishedRunId: 'run-a',
        publishedRunFencingVersion: 1,
      }),
    );
    prisma.generationRun.findFirst
      .mockResolvedValueOnce(makeRun({ id: 'run-b', status: 'failed' }))
      .mockResolvedValueOnce(makeRun({ id: 'run-a', status: 'completed' }));

    const result = await service.getGenerationDiagnostics('book-1', 'user-1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    expect(prisma.generationRun.findFirst).toHaveBeenNthCalledWith(1, {
      where: { bookId: 'book-1', userId: 'user-1' },
      orderBy: { createdAt: 'desc' },
    });
    expect(prisma.generationRun.findFirst).toHaveBeenNthCalledWith(2, {
      where: { id: 'run-a', bookId: 'book-1', userId: 'user-1' },
    });
    expect(prisma.agentLog.findMany).toHaveBeenCalledWith({
      where: { bookId: 'book-1' },
      orderBy: { createdAt: 'desc' },
      take: DIAGNOSTICS_RECENT_LOG_LIMIT,
    });
    expect(runs.findLatestForBook).not.toHaveBeenCalled();
    expect(readsOutsideSnapshot).toEqual([]);
    expect(result.latestAttempt).toMatchObject({ runId: 'run-b', isPublishedSource: false });
    expect(result.publishedEdition?.sourceGenerationRun).toMatchObject({
      availability: 'recorded',
      runId: 'run-a',
    });
  });

  it('reuses the latest run as the published source instead of querying it twice', async () => {
    prisma.book.findFirst.mockResolvedValue(
      makeBook({
        status: 'complete',
        previewPdfUrl: '/files/books/book-1/runs/run-a/claims/1/storyme-preview-book-1.pdf',
        publishedRunId: 'run-a',
        publishedRunFencingVersion: 1,
      }),
    );
    prisma.generationRun.findFirst.mockResolvedValue(makeRun({ id: 'run-a', status: 'completed' }));

    const result = await service.getGenerationDiagnostics('book-1', 'user-1');

    expect(prisma.generationRun.findFirst).toHaveBeenCalledTimes(1);
    expect(result.latestAttempt?.isPublishedSource).toBe(true);
  });

  it('projects the latest run and uses it for no-worker detection', async () => {
    prisma.generationRun.findFirst.mockResolvedValue(
      makeRun({ id: 'run-9', kind: 'retry', status: 'running', attempt: 2 }),
    );
    queue.getQueueDiagnostics.mockResolvedValue({
      queueName: 'book-generation',
      workerCount: 0,
      counts: { waiting: 0, active: 1, completed: 0, failed: 0, delayed: 0 },
    });

    const result = await service.getGenerationDiagnostics('book-1', 'user-1');

    expect(result.latestAttempt).toMatchObject({
      runId: 'run-9',
      kind: 'retry',
      status: 'running',
      deliveryAttempt: 2,
    });
    expect(result.latestJob).toMatchObject({ id: 'run-9', type: 'retry', status: 'running' });
    expect(result.queue.stalledNoWorker).toBe(true);
  });

  it('observes storage for the exact published claim namespace after the snapshot', async () => {
    prisma.book.findFirst.mockResolvedValue(
      makeBook({
        previewPdfUrl: '/files/books/book-1/runs/run-7/claims/3/storyme-preview-book-1.pdf',
        publishedRunId: 'run-7',
        publishedRunFencingVersion: 3,
      }),
    );
    pdfStorage.claimPreviewPdfExists.mockImplementation(async () => {
      expect(inSnapshot).toBe(false);
      return true;
    });

    const result = await service.getGenerationDiagnostics('book-1', 'user-1');

    expect(pdfStorage.claimPreviewPdfExists).toHaveBeenCalledWith('book-1', {
      kind: 'claim',
      runId: 'run-7',
      fencingVersion: 3,
    });
    expect(pdfStorage.previewPdfExists).not.toHaveBeenCalled();
    expect(result.pdfStorage).toEqual({
      driver: 'local',
      keyPresent: true,
      previewAvailable: true,
    });
  });

  it('does not query storage when no publication pointer exists', async () => {
    const result = await service.getGenerationDiagnostics('book-1', 'user-1');

    expect(pdfStorage.previewPdfExists).not.toHaveBeenCalled();
    expect(pdfStorage.claimPreviewPdfExists).not.toHaveBeenCalled();
    expect(result.pdfStorage).toMatchObject({
      keyPresent: false,
      previewAvailable: false,
    });
    expect(result.publishedEdition).toBeNull();
  });

  it('returns idle progress when the owned book has never had a run', async () => {
    const result = await service.getGenerationProgress('book-1', 'user-1');

    expect(result).toEqual({ status: 'idle', step: null });
    expect(runs.findLatestForBook).toHaveBeenCalledWith('book-1');
    expect(prisma.agentLog.findMany).not.toHaveBeenCalled();
    expect(queue.getQueueDiagnostics).not.toHaveBeenCalled();
  });

  it('projects only durable run status and current step into user-facing progress', async () => {
    runs.findLatestForBook.mockResolvedValue(
      makeRun({ status: 'running', currentStep: 'image_gen' }),
    );

    await expect(service.getGenerationProgress('book-1', 'user-1')).resolves.toEqual({
      status: 'running',
      step: 'image_gen',
    });
  });

  it('maps the internal completed run status to the public complete status', async () => {
    runs.findLatestForBook.mockResolvedValue(
      makeRun({ status: 'completed', currentStep: 'pdf_render' }),
    );

    await expect(service.getGenerationProgress('book-1', 'user-1')).resolves.toEqual({
      status: 'complete',
      step: 'pdf_render',
    });
  });

  it('checks ownership before reading the latest run for progress', async () => {
    crud.findOwnedOrThrow.mockRejectedValue(new NotFoundException('Book not found'));

    await expect(service.getGenerationProgress('book-1', 'other-user')).rejects.toThrow(
      NotFoundException,
    );
    expect(runs.findLatestForBook).not.toHaveBeenCalled();
  });
});
