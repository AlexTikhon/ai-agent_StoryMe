import { NotFoundException } from '@nestjs/common';
import type { Book, GenerationRun } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationQueueService } from '../agent/generation-queue.service';
import type { GenerationRunService } from '../agent/generation-run.service';
import { createMockPrisma } from '../common/test-utils/mock-prisma';
import type { PdfStorage } from '../pdf/pdf-storage';
import type { BookCrudService } from './book-crud.service';
import { BookDiagnosticsService } from './book-diagnostics.service';

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
    startedAt: null,
    completedAt: null,
    failedAt: null,
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

  beforeEach(() => {
    vi.clearAllMocks();
    crud.findOwnedOrThrow.mockResolvedValue(makeBook());
    prisma.agentLog.findMany.mockResolvedValue([]);
    runs.findLatestForBook.mockResolvedValue(null);
    queue.getQueueDiagnostics.mockResolvedValue({
      queueName: 'book-generation',
      workerCount: 1,
      counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
    });
    service = new BookDiagnosticsService(crud, prisma as never, runs, queue, pdfStorage);
  });

  it('stops at the owned-book boundary before reading diagnostics dependencies', async () => {
    crud.findOwnedOrThrow.mockRejectedValue(new NotFoundException('Book not found'));

    await expect(service.getGenerationDiagnostics('book-1', 'other-user')).rejects.toThrow(
      NotFoundException,
    );

    expect(prisma.agentLog.findMany).not.toHaveBeenCalled();
    expect(runs.findLatestForBook).not.toHaveBeenCalled();
    expect(queue.getQueueDiagnostics).not.toHaveBeenCalled();
  });

  it('projects the latest authoritative run and uses it for no-worker detection', async () => {
    runs.findLatestForBook.mockResolvedValue(
      makeRun({ id: 'run-9', kind: 'retry', status: 'running', attempt: 2 }),
    );
    queue.getQueueDiagnostics.mockResolvedValue({
      queueName: 'book-generation',
      workerCount: 0,
      counts: { waiting: 0, active: 1, completed: 0, failed: 0, delayed: 0 },
    });

    const result = await service.getGenerationDiagnostics('book-1', 'user-1');

    expect(runs.findLatestForBook).toHaveBeenCalledWith('book-1');
    expect(result.latestJob).toMatchObject({
      id: 'run-9',
      type: 'retry',
      status: 'running',
      attempt: 2,
    });
    expect(result.queue.stalledNoWorker).toBe(true);
  });

  it('checks only the exact published claim namespace', async () => {
    crud.findOwnedOrThrow.mockResolvedValue(
      makeBook({
        previewPdfUrl: '/files/books/book-1/runs/run-7/claims/3/storyme-preview-book-1.pdf',
        publishedRunId: 'run-7',
        publishedRunFencingVersion: 3,
      }),
    );
    pdfStorage.claimPreviewPdfExists.mockResolvedValue(true);

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
  });
});
