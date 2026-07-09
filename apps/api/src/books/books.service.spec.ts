import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Book, type GenerationJob } from '@prisma/client';
import { BooksService } from './books.service';
import type { AgentService } from '../agent/agent.service';
import type { GenerationQueueService } from '../agent/generation-queue.service';
import type { GenerationJobService } from '../agent/generation-job.service';
import type { PdfStorage } from '../pdf/pdf-storage';
import { GENERATION_INTERRUPTED_MESSAGE } from '../agent/generation-job-recovery.service';
import { createMockPrisma } from '../common/test-utils/mock-prisma';
import type { CreateBookDto } from './dto/create-book.dto';
import type { UpdateBookDto } from './dto/update-book.dto';

type MockPrisma = ReturnType<typeof createMockPrisma>;

function createMockAgentService(): jest.Mocked<AgentService> {
  return { startBookGeneration: vi.fn() } as unknown as jest.Mocked<AgentService>;
}

function createMockPdfStorage(): jest.Mocked<PdfStorage> {
  return {
    driver: 'local',
    savePreviewPdf: vi.fn(),
    getPreviewPdf: vi.fn(),
    previewPdfExists: vi.fn().mockResolvedValue(false),
  } as unknown as jest.Mocked<PdfStorage>;
}

function createMockGenerationQueueService(): jest.Mocked<GenerationQueueService> {
  return {
    enqueue: vi.fn().mockResolvedValue(undefined),
    getQueueDiagnostics: vi.fn().mockResolvedValue({
      queueName: 'book-generation',
      workerCount: 1,
      counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
    }),
  } as unknown as jest.Mocked<GenerationQueueService>;
}

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
    createdAt: new Date('2026-01-01'),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

/** Simulates the "record not found" error Prisma throws when a conditional update's WHERE clause matches zero rows — the concurrency guard's signal that another request already won the race. */
function recordNotFoundError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
    code: 'P2025',
    clientVersion: '5.17.0',
  });
}

function createMockGenerationJobService(): jest.Mocked<GenerationJobService> {
  return {
    findActive: vi.fn().mockResolvedValue(null),
    findLatest: vi.fn().mockResolvedValue(null),
    createQueued: vi.fn().mockResolvedValue(makeGenerationJob()),
    markRunning: vi
      .fn()
      .mockResolvedValue(makeGenerationJob({ status: 'running' as GenerationJob['status'] })),
    markCompleted: vi
      .fn()
      .mockResolvedValue(makeGenerationJob({ status: 'completed' as GenerationJob['status'] })),
    markFailed: vi
      .fn()
      .mockResolvedValue(makeGenerationJob({ status: 'failed' as GenerationJob['status'] })),
  } as unknown as jest.Mocked<GenerationJobService>;
}

// Prisma emits string enum values that match the schema — 'created', 'preview_ready', etc.
const STATUS_CREATED = 'created' as Book['status'];
const STATUS_IN_PROGRESS = 'preview_ready' as Book['status'];
const STATUS_CHAR_BUILD = 'char_build' as Book['status'];
const STATUS_FAILED = 'failed' as Book['status'];
const STATUS_COMPLETE = 'complete' as Book['status'];

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'b-1',
    userId: 'u-1',
    childProfileId: null,
    status: STATUS_CREATED,
    request: null,
    title: 'The Adventures of Mia',
    dedicationText: null,
    pageCount: null,
    childName: 'Mia',
    childAge: 5,
    language: 'en' as Book['language'],
    theme: 'friendship',
    educationalMessage: null,
    characterCard: null,
    storyPlan: null,
    bookPreview: null,
    imageGenerationResult: null,
    bookLayout: null,
    chapters: null,
    imagePrompts: null,
    qualityReport: null,
    pageLayouts: null,
    coverUrl: null,
    pdfR2Key: null,
    pdfUrl: null,
    printPdfR2Key: null,
    printPdfUrl: null,
    previewPdfR2Key: null,
    previewPdfUrl: null,
    socialCardUrl: null,
    isPaid: false,
    paidAt: null,
    stripePaymentIntentId: null,
    isPublic: false,
    generationTimeMs: null,
    totalCostUsd: null,
    aiModelVersions: null,
    generatedDegraded: false,
    errorMessage: null,
    retryCount: 0,
    failedStep: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('BooksService', () => {
  let service: BooksService;
  let prisma: MockPrisma;
  let agentService: ReturnType<typeof createMockAgentService>;
  let pdfStorage: ReturnType<typeof createMockPdfStorage>;
  let generationQueueService: ReturnType<typeof createMockGenerationQueueService>;
  let generationJobService: ReturnType<typeof createMockGenerationJobService>;

  beforeEach(() => {
    prisma = createMockPrisma();
    agentService = createMockAgentService();
    pdfStorage = createMockPdfStorage();
    generationQueueService = createMockGenerationQueueService();
    generationJobService = createMockGenerationJobService();
    service = new BooksService(
      prisma as never,
      agentService as never,
      pdfStorage as never,
      generationQueueService as never,
      generationJobService as never,
    );
  });

  // ─── create ──────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('persists a new book and returns a BookDto', async () => {
      const dto: CreateBookDto = {
        title: 'The Adventures of Mia',
        childName: 'Mia',
        childAge: 5,
        language: 'en' as CreateBookDto['language'],
        theme: 'friendship',
        educationalMessage: 'Kindness matters',
        pageCount: 8,
      };
      const book = makeBook({ userId: 'u-1' });
      prisma.book.create.mockResolvedValue(book);

      const result = await service.create('u-1', dto);

      expect(prisma.book.create).toHaveBeenCalledWith({
        data: {
          userId: 'u-1',
          title: dto.title,
          childName: dto.childName,
          childAge: dto.childAge,
          language: dto.language,
          theme: dto.theme,
          educationalMessage: dto.educationalMessage,
          pageCount: dto.pageCount,
        },
      });
      expect(result.id).toBe(book.id);
      expect(result.userId).toBe('u-1');
      expect(result.title).toBe(book.title);
    });

    it('defaults language to English when omitted from the dto', async () => {
      const dto: CreateBookDto = {
        title: 'The Adventures of Mia',
        childName: 'Mia',
        childAge: 5,
        theme: 'friendship',
      };
      prisma.book.create.mockResolvedValue(makeBook({ userId: 'u-1' }));

      await service.create('u-1', dto);

      expect(prisma.book.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ language: 'en' }),
      });
    });

    it('defaults pageCount to 6 when omitted from the dto', async () => {
      const dto: CreateBookDto = {
        title: 'The Adventures of Mia',
        childName: 'Mia',
        childAge: 5,
        language: 'en' as CreateBookDto['language'],
        theme: 'friendship',
      };
      prisma.book.create.mockResolvedValue(makeBook({ userId: 'u-1' }));

      await service.create('u-1', dto);

      expect(prisma.book.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ pageCount: 6 }),
      });
    });

    it('persists educationalMessage as null when omitted from the dto', async () => {
      const dto: CreateBookDto = {
        title: 'The Adventures of Mia',
        childName: 'Mia',
        childAge: 5,
        language: 'en' as CreateBookDto['language'],
        theme: 'friendship',
      };
      prisma.book.create.mockResolvedValue(makeBook({ userId: 'u-1' }));

      await service.create('u-1', dto);

      expect(prisma.book.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ educationalMessage: null }),
      });
    });
  });

  // ─── findAllForUser ───────────────────────────────────────────────────────────

  describe('findAllForUser', () => {
    it('returns paginated BookDtos for the given user', async () => {
      const books = [makeBook({ id: 'b-1' }), makeBook({ id: 'b-2' })];
      prisma.book.count.mockResolvedValue(2);
      prisma.book.findMany.mockResolvedValue(books);

      const result = await service.findAllForUser('u-1', 1, 20);

      expect(prisma.book.findMany).toHaveBeenCalledWith({
        where: { userId: 'u-1', deletedAt: null },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 20,
      });
      expect(result.items).toHaveLength(2);
      expect(result.items[0]?.id).toBe('b-1');
      expect(result.items[1]?.id).toBe('b-2');
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.total).toBe(2);
    });

    it('returns empty items array when the user has no books', async () => {
      prisma.book.count.mockResolvedValue(0);
      prisma.book.findMany.mockResolvedValue([]);

      const result = await service.findAllForUser('u-1', 1, 20);

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('applies page offset as skip', async () => {
      prisma.book.count.mockResolvedValue(10);
      prisma.book.findMany.mockResolvedValue([]);

      await service.findAllForUser('u-1', 2, 5);

      expect(prisma.book.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 5 }),
      );
    });

    it('clamps limit to 50', async () => {
      prisma.book.count.mockResolvedValue(0);
      prisma.book.findMany.mockResolvedValue([]);

      const result = await service.findAllForUser('u-1', 1, 999);

      expect(result.limit).toBe(50);
      expect(prisma.book.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
    });
  });

  // ─── findOneForUser ───────────────────────────────────────────────────────────

  describe('findOneForUser', () => {
    it('returns a BookDto when the book belongs to the user', async () => {
      const book = makeBook({ id: 'b-1', userId: 'u-1' });
      prisma.book.findFirst.mockResolvedValue(book);

      const result = await service.findOneForUser('b-1', 'u-1');

      expect(prisma.book.findFirst).toHaveBeenCalledWith({
        where: { id: 'b-1', userId: 'u-1', deletedAt: null },
      });
      expect(result.id).toBe('b-1');
    });

    it('throws NotFoundException when book belongs to a different user', async () => {
      // findFirst returns null because the userId filter excludes the row
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.findOneForUser('b-1', 'u-other')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when book does not exist', async () => {
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.findOneForUser('no-such-id', 'u-1')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── update ───────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates and returns BookDto when status is created', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      const updated = makeBook({ title: 'New Title', status: STATUS_CREATED });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(updated);

      const dto: UpdateBookDto = { title: 'New Title' };
      const result = await service.update('b-1', 'u-1', dto);

      expect(prisma.book.update).toHaveBeenCalledWith({
        where: { id: 'b-1' },
        data: dto,
      });
      expect(result.title).toBe('New Title');
    });

    it('throws ConflictException when the book is actively generating', async () => {
      const book = makeBook({ status: STATUS_IN_PROGRESS });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.update('b-1', 'u-1', { title: 'X' })).rejects.toThrow(ConflictException);
      expect(prisma.book.update).not.toHaveBeenCalled();
    });

    it('updates a complete book (edit-then-regenerate flow)', async () => {
      const book = makeBook({ status: STATUS_COMPLETE });
      const updated = makeBook({ title: 'New Title', status: STATUS_COMPLETE });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(updated);

      const result = await service.update('b-1', 'u-1', { title: 'New Title' });

      expect(prisma.book.update).toHaveBeenCalledWith({
        where: { id: 'b-1' },
        data: { title: 'New Title' },
      });
      expect(result.title).toBe('New Title');
    });

    it('updates a failed book', async () => {
      const book = makeBook({ status: STATUS_FAILED });
      const updated = makeBook({ title: 'New Title', status: STATUS_FAILED });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(updated);

      const result = await service.update('b-1', 'u-1', { title: 'New Title' });

      expect(result.title).toBe('New Title');
    });
  });

  // ─── remove ───────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('soft-deletes by setting deletedAt when status is created', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue({ ...book, deletedAt: new Date() });

      await service.remove('b-1', 'u-1');

      expect(prisma.book.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'b-1' },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });

    it('throws ConflictException when the book is actively generating', async () => {
      const book = makeBook({ status: STATUS_IN_PROGRESS });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.remove('b-1', 'u-1')).rejects.toThrow(ConflictException);
      expect(prisma.book.update).not.toHaveBeenCalled();
    });

    it('soft-deletes a complete book', async () => {
      const book = makeBook({ status: STATUS_COMPLETE });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue({ ...book, deletedAt: new Date() });

      await service.remove('b-1', 'u-1');

      expect(prisma.book.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'b-1' },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });

    it('soft-deletes a failed book', async () => {
      const book = makeBook({ status: STATUS_FAILED });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue({ ...book, deletedAt: new Date() });

      await service.remove('b-1', 'u-1');

      expect(prisma.book.update).toHaveBeenCalled();
    });

    it('throws NotFoundException when book does not exist', async () => {
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.remove('no-such', 'u-1')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── startGeneration ─────────────────────────────────────────────────────────

  describe('startGeneration', () => {
    it('transitions status to char_build and returns quickly, without waiting for the pipeline', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      const started = makeBook({ status: STATUS_CHAR_BUILD });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(started);

      const result = await service.startGeneration('u-1', 'b-1');

      expect(prisma.book.update).toHaveBeenCalledWith({
        where: { id: 'b-1', status: STATUS_CREATED },
        data: { status: 'char_build' },
      });
      expect(result.book.status).toBe('char_build');
      expect(result.book.id).toBe('b-1');
      // The pipeline itself is scheduled in the background, not awaited here.
      expect(agentService.startBookGeneration).not.toHaveBeenCalled();
    });

    it('enqueues the pipeline onto the durable generation queue', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      const started = makeBook({ status: STATUS_CHAR_BUILD });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(started);

      await service.startGeneration('u-1', 'b-1');

      expect(generationQueueService.enqueue).toHaveBeenCalledOnce();
      expect(generationQueueService.enqueue).toHaveBeenCalledWith({
        bookId: 'b-1',
        jobId: 'job-1',
      });
    });

    it('logs the status transition from created to char_build', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const book = makeBook({ status: STATUS_CREATED });
      const started = makeBook({ status: STATUS_CHAR_BUILD });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(started);

      await service.startGeneration('u-1', 'b-1');

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`${STATUS_CREATED} -> char_build`));
      logSpy.mockRestore();
    });

    it('runGenerationPipeline (invoked by the queue worker) calls AgentService.startBookGeneration with the freshly-loaded book', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      const started = makeBook({ status: STATUS_CHAR_BUILD });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(started);
      prisma.book.findUniqueOrThrow.mockResolvedValue(started);
      agentService.startBookGeneration.mockResolvedValue(makeBook({ status: STATUS_COMPLETE }));

      await service.startGeneration('u-1', 'b-1');
      await service.runGenerationPipeline('b-1', 'job-1');

      expect(prisma.book.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 'b-1' } });
      expect(agentService.startBookGeneration).toHaveBeenCalledOnce();
      expect(agentService.startBookGeneration).toHaveBeenCalledWith(started);
    });

    it('marks the book failed if the queued pipeline run throws unexpectedly', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      const started = makeBook({ status: STATUS_CHAR_BUILD });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValueOnce(started);
      prisma.book.findUniqueOrThrow.mockResolvedValue(started);
      agentService.startBookGeneration.mockRejectedValue(new Error('unexpected pipeline crash'));
      prisma.book.update.mockResolvedValueOnce(makeBook({ status: STATUS_FAILED }));

      await service.startGeneration('u-1', 'b-1');
      await expect(service.runGenerationPipeline('b-1', 'job-1')).resolves.toBeUndefined();

      expect(prisma.book.update).toHaveBeenLastCalledWith({
        where: { id: 'b-1' },
        data: { status: 'failed', errorMessage: 'unexpected pipeline crash' },
      });
      // The GenerationJob mirrors the same unexpected failure, without blocking it.
      expect(generationJobService.markFailed).toHaveBeenCalledWith('job-1', {
        errorMessage: 'unexpected pipeline crash',
      });
    });

    it('creates a queued GenerationJob (type generate, attempt 1) and enqueues the pipeline with its id', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      const started = makeBook({ status: STATUS_CHAR_BUILD });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(started);

      await service.startGeneration('u-1', 'b-1');

      expect(generationJobService.createQueued).toHaveBeenCalledWith({
        bookId: 'b-1',
        userId: 'u-1',
        type: 'generate',
        attempt: 1,
      });
      expect(generationQueueService.enqueue).toHaveBeenCalledWith({
        bookId: 'b-1',
        jobId: 'job-1',
      });
    });

    it('runGenerationPipeline marks the job running then completed when the pipeline succeeds', async () => {
      const started = makeBook({ status: STATUS_CHAR_BUILD });
      prisma.book.findUniqueOrThrow.mockResolvedValue(started);
      agentService.startBookGeneration.mockResolvedValue(makeBook({ status: STATUS_COMPLETE }));

      await service.runGenerationPipeline('b-1', 'job-1');

      expect(generationJobService.markRunning).toHaveBeenCalledWith('job-1');
      expect(generationJobService.markCompleted).toHaveBeenCalledWith('job-1');
      expect(generationJobService.markFailed).not.toHaveBeenCalled();
    });

    it('runGenerationPipeline logs the book status transition (e.g. char_build -> complete)', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const started = makeBook({ status: STATUS_CHAR_BUILD });
      prisma.book.findUniqueOrThrow.mockResolvedValue(started);
      agentService.startBookGeneration.mockResolvedValue(makeBook({ status: STATUS_COMPLETE }));

      await service.runGenerationPipeline('b-1', 'job-1');

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('char_build -> complete'));
      logSpy.mockRestore();
    });

    it('runGenerationPipeline marks the job failed (with failedStep/errorMessage) when AgentService returns a failed book', async () => {
      const started = makeBook({ status: STATUS_CHAR_BUILD });
      prisma.book.findUniqueOrThrow.mockResolvedValue(started);
      agentService.startBookGeneration.mockResolvedValue(
        makeBook({
          status: STATUS_FAILED,
          failedStep: 'image_gen' as Book['failedStep'],
          errorMessage: 'OpenAI image request failed',
        }),
      );

      await service.runGenerationPipeline('b-1', 'job-1');

      expect(generationJobService.markFailed).toHaveBeenCalledWith('job-1', {
        errorMessage: 'OpenAI image request failed',
        failedStep: 'image_gen',
      });
      expect(generationJobService.markCompleted).not.toHaveBeenCalled();
    });

    it('throws ConflictException when an active GenerationJob already exists for the book', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      prisma.book.findFirst.mockResolvedValue(book);
      generationJobService.findActive.mockResolvedValue(
        makeGenerationJob({ status: 'running' as GenerationJob['status'] }),
      );

      await expect(service.startGeneration('u-1', 'b-1')).rejects.toThrow(ConflictException);
      expect(prisma.book.update).not.toHaveBeenCalled();
      expect(generationQueueService.enqueue).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when book does not exist', async () => {
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.startGeneration('u-1', 'no-such')).rejects.toThrow(NotFoundException);
      expect(generationQueueService.enqueue).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when book belongs to a different user', async () => {
      // findFirst returns null because userId filter excludes the row
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.startGeneration('u-other', 'b-1')).rejects.toThrow(NotFoundException);
      expect(generationQueueService.enqueue).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a soft-deleted book', async () => {
      // findOwnedOrThrow filters deletedAt: null — deleted books appear as not found
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.startGeneration('u-1', 'b-deleted')).rejects.toThrow(NotFoundException);
      expect(generationQueueService.enqueue).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when childName is missing', async () => {
      const book = makeBook({ childName: null });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.startGeneration('u-1', 'b-1')).rejects.toThrow(BadRequestException);
      expect(generationQueueService.enqueue).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when childAge is missing', async () => {
      const book = makeBook({ childAge: null });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.startGeneration('u-1', 'b-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when language is missing', async () => {
      const book = makeBook({ language: null });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.startGeneration('u-1', 'b-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when theme is missing', async () => {
      const book = makeBook({ theme: null });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.startGeneration('u-1', 'b-1')).rejects.toThrow(BadRequestException);
    });

    it('error message lists all missing fields', async () => {
      const book = makeBook({ childName: null, language: null });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.startGeneration('u-1', 'b-1')).rejects.toThrow(
        /Missing required draft fields:.*childName.*language/,
      );
    });

    it('throws ConflictException when generation is already started', async () => {
      const book = makeBook({ status: STATUS_IN_PROGRESS });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.startGeneration('u-1', 'b-1')).rejects.toThrow(ConflictException);
      expect(generationQueueService.enqueue).not.toHaveBeenCalled();
    });

    describe('concurrency', () => {
      it('claims the transition with a conditional update guarded on the current status', async () => {
        const book = makeBook({ status: STATUS_CREATED });
        const started = makeBook({ status: STATUS_CHAR_BUILD });
        prisma.book.findFirst.mockResolvedValue(book);
        prisma.book.update.mockResolvedValue(started);

        await service.startGeneration('u-1', 'b-1');

        expect(prisma.book.update).toHaveBeenCalledWith({
          where: { id: 'b-1', status: STATUS_CREATED },
          data: { status: 'char_build' },
        });
      });

      it('throws ConflictException (and never schedules a job) when a concurrent request already won the status transition', async () => {
        // Both requests pass the pre-checks (findFirst still sees `created`),
        // but the conditional UPDATE's WHERE clause loses the race — Prisma
        // reports zero matching rows as a P2025 "record not found" error.
        const book = makeBook({ status: STATUS_CREATED });
        prisma.book.findFirst.mockResolvedValue(book);
        prisma.book.update.mockRejectedValue(recordNotFoundError());

        await expect(service.startGeneration('u-1', 'b-1')).rejects.toThrow(ConflictException);
        expect(generationJobService.createQueued).not.toHaveBeenCalled();
        expect(generationQueueService.enqueue).not.toHaveBeenCalled();
      });

      it('re-throws unrelated prisma errors from the conditional update instead of masking them as a conflict', async () => {
        const book = makeBook({ status: STATUS_CREATED });
        prisma.book.findFirst.mockResolvedValue(book);
        prisma.book.update.mockRejectedValue(new Error('connection reset'));

        await expect(service.startGeneration('u-1', 'b-1')).rejects.toThrow('connection reset');
        expect(generationJobService.createQueued).not.toHaveBeenCalled();
      });

      it('marks the book and job failed and throws InternalServerErrorException when the queue enqueue fails right after the atomic claim', async () => {
        const book = makeBook({ status: STATUS_CREATED });
        const started = makeBook({ status: STATUS_CHAR_BUILD });
        prisma.book.findFirst.mockResolvedValue(book);
        prisma.book.update.mockResolvedValue(started);
        generationQueueService.enqueue.mockRejectedValue(new Error('Redis connection refused'));

        await expect(service.startGeneration('u-1', 'b-1')).rejects.toThrow(
          InternalServerErrorException,
        );

        expect(generationJobService.markFailed).toHaveBeenCalledWith('job-1', {
          errorMessage: 'Could not schedule generation — please try again',
        });
        expect(prisma.book.update).toHaveBeenLastCalledWith({
          where: { id: 'b-1' },
          data: {
            status: 'failed',
            errorMessage: 'Could not schedule generation — please try again',
          },
        });
      });
    });
  });

  // ─── retryGeneration ─────────────────────────────────────────────────────────

  describe('retryGeneration', () => {
    it('clears failedStep/errorMessage, transitions to char_build, and returns quickly', async () => {
      const book = makeBook({
        status: STATUS_FAILED,
        failedStep: 'pdf_render' as Book['failedStep'],
        errorMessage: 'PDF render failed',
      });
      const cleared = makeBook({ status: STATUS_CHAR_BUILD, failedStep: null, errorMessage: null });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);

      const result = await service.retryGeneration('u-1', 'b-1');

      expect(prisma.book.update).toHaveBeenCalledWith({
        where: { id: 'b-1', status: STATUS_FAILED },
        data: expect.objectContaining({
          status: 'char_build',
          failedStep: null,
          errorMessage: null,
        }),
      });
      expect(result.book.status).toBe('char_build');
      // The pipeline itself is scheduled in the background, not awaited here.
      expect(agentService.startBookGeneration).not.toHaveBeenCalled();
    });

    it('retries a book left failed by startup recovery (Phase 3J) same as any other failure', async () => {
      const book = makeBook({
        status: STATUS_FAILED,
        failedStep: null,
        errorMessage: GENERATION_INTERRUPTED_MESSAGE,
      });
      const cleared = makeBook({ status: STATUS_CHAR_BUILD, failedStep: null, errorMessage: null });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);

      const result = await service.retryGeneration('u-1', 'b-1');

      expect(result.book.status).toBe('char_build');
      expect(generationQueueService.enqueue).toHaveBeenCalledOnce();
    });

    it('enqueues the pipeline onto the durable generation queue', async () => {
      const book = makeBook({ status: STATUS_FAILED });
      const cleared = makeBook({ status: STATUS_CHAR_BUILD, failedStep: null, errorMessage: null });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);

      await service.retryGeneration('u-1', 'b-1');

      expect(generationQueueService.enqueue).toHaveBeenCalledOnce();
      expect(generationQueueService.enqueue).toHaveBeenCalledWith({
        bookId: 'b-1',
        jobId: 'job-1',
      });
    });

    it('runGenerationPipeline (invoked by the queue worker) calls AgentService.startBookGeneration with the freshly-loaded (cleared) book', async () => {
      const book = makeBook({ status: STATUS_FAILED });
      const cleared = makeBook({ status: STATUS_CHAR_BUILD, failedStep: null, errorMessage: null });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);
      prisma.book.findUniqueOrThrow.mockResolvedValue(cleared);
      agentService.startBookGeneration.mockResolvedValue(makeBook({ status: STATUS_COMPLETE }));

      await service.retryGeneration('u-1', 'b-1');
      await service.runGenerationPipeline('b-1', 'job-1');

      expect(agentService.startBookGeneration).toHaveBeenCalledWith(cleared);
    });

    it('creates a retry GenerationJob with attempt incremented past the post-increment retryCount', async () => {
      const book = makeBook({ status: STATUS_FAILED });
      // retryCount is already incremented by the prisma.book.update mock below.
      const cleared = makeBook({
        status: STATUS_CHAR_BUILD,
        failedStep: null,
        errorMessage: null,
        retryCount: 1,
      });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);

      await service.retryGeneration('u-1', 'b-1');

      expect(generationJobService.createQueued).toHaveBeenCalledWith({
        bookId: 'b-1',
        userId: 'u-1',
        type: 'retry',
        attempt: 2,
      });
    });

    it('throws ConflictException when an active GenerationJob already exists for the book', async () => {
      const book = makeBook({ status: STATUS_FAILED });
      prisma.book.findFirst.mockResolvedValue(book);
      generationJobService.findActive.mockResolvedValue(
        makeGenerationJob({ status: 'queued' as GenerationJob['status'] }),
      );

      await expect(service.retryGeneration('u-1', 'b-1')).rejects.toThrow(ConflictException);
      expect(prisma.book.update).not.toHaveBeenCalled();
      expect(generationQueueService.enqueue).not.toHaveBeenCalled();
    });

    it('allows retry when the book is failed and no active job exists (a prior completed/failed job does not block it)', async () => {
      const book = makeBook({ status: STATUS_FAILED });
      const cleared = makeBook({ status: STATUS_CHAR_BUILD, failedStep: null, errorMessage: null });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);
      generationJobService.findActive.mockResolvedValue(null);

      await expect(service.retryGeneration('u-1', 'b-1')).resolves.toBeDefined();
      expect(generationQueueService.enqueue).toHaveBeenCalledOnce();
    });

    it('throws ConflictException when the book is not failed (e.g. still generating)', async () => {
      const book = makeBook({ status: STATUS_IN_PROGRESS });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.retryGeneration('u-1', 'b-1')).rejects.toThrow(ConflictException);
      expect(prisma.book.update).not.toHaveBeenCalled();
      expect(generationQueueService.enqueue).not.toHaveBeenCalled();
    });

    it('regenerates a complete book (edit-then-regenerate / regenerate-book flow)', async () => {
      const book = makeBook({ status: STATUS_COMPLETE });
      const cleared = makeBook({ status: STATUS_CHAR_BUILD, failedStep: null, errorMessage: null });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);

      const result = await service.retryGeneration('u-1', 'b-1');

      expect(prisma.book.update).toHaveBeenCalledWith({
        where: { id: 'b-1', status: STATUS_COMPLETE },
        data: expect.objectContaining({ status: 'char_build' }),
      });
      expect(result.book.status).toBe('char_build');
      expect(generationQueueService.enqueue).toHaveBeenCalledOnce();
    });

    describe('concurrency', () => {
      it('claims the transition with a conditional update guarded on the current status', async () => {
        const book = makeBook({ status: STATUS_FAILED });
        const cleared = makeBook({
          status: STATUS_CHAR_BUILD,
          failedStep: null,
          errorMessage: null,
        });
        prisma.book.findFirst.mockResolvedValue(book);
        prisma.book.update.mockResolvedValue(cleared);

        await service.retryGeneration('u-1', 'b-1');

        expect(prisma.book.update).toHaveBeenCalledWith({
          where: { id: 'b-1', status: STATUS_FAILED },
          data: {
            status: 'char_build',
            failedStep: null,
            errorMessage: null,
            retryCount: { increment: 1 },
          },
        });
      });

      it('throws ConflictException (and never schedules a job) when a concurrent retry already won the status transition', async () => {
        const book = makeBook({ status: STATUS_FAILED });
        prisma.book.findFirst.mockResolvedValue(book);
        prisma.book.update.mockRejectedValue(recordNotFoundError());

        await expect(service.retryGeneration('u-1', 'b-1')).rejects.toThrow(ConflictException);
        expect(generationJobService.createQueued).not.toHaveBeenCalled();
        expect(generationQueueService.enqueue).not.toHaveBeenCalled();
      });

      it('marks the book and job failed and throws InternalServerErrorException when the queue enqueue fails right after the atomic claim', async () => {
        const book = makeBook({ status: STATUS_FAILED });
        const cleared = makeBook({
          status: STATUS_CHAR_BUILD,
          failedStep: null,
          errorMessage: null,
        });
        prisma.book.findFirst.mockResolvedValue(book);
        prisma.book.update.mockResolvedValue(cleared);
        generationQueueService.enqueue.mockRejectedValue(new Error('Redis connection refused'));

        await expect(service.retryGeneration('u-1', 'b-1')).rejects.toThrow(
          InternalServerErrorException,
        );

        expect(generationJobService.markFailed).toHaveBeenCalledWith('job-1', {
          errorMessage: 'Could not schedule generation — please try again',
        });
        expect(prisma.book.update).toHaveBeenLastCalledWith({
          where: { id: 'b-1' },
          data: {
            status: 'failed',
            errorMessage: 'Could not schedule generation — please try again',
          },
        });
      });
    });

    it('throws NotFoundException when the book belongs to a different user', async () => {
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.retryGeneration('u-other', 'b-1')).rejects.toThrow(NotFoundException);
      expect(prisma.book.update).not.toHaveBeenCalled();
      expect(generationQueueService.enqueue).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the book does not exist', async () => {
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.retryGeneration('u-1', 'no-such')).rejects.toThrow(NotFoundException);
    });

    it('never deletes AgentLog history — retry relies on AgentService appending new rows', async () => {
      const book = makeBook({ status: STATUS_FAILED });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(book);

      await service.retryGeneration('u-1', 'b-1');

      expect(prisma.agentLog.deleteMany).not.toHaveBeenCalled();
      expect(prisma.agentLog.delete).not.toHaveBeenCalled();
    });

    it('reuses AgentService.startBookGeneration rather than duplicating pipeline logic', async () => {
      const book = makeBook({ status: STATUS_FAILED });
      const cleared = makeBook({ status: STATUS_CHAR_BUILD, failedStep: null, errorMessage: null });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);
      prisma.book.findUniqueOrThrow.mockResolvedValue(cleared);
      agentService.startBookGeneration.mockResolvedValue(makeBook({ status: STATUS_COMPLETE }));

      await service.retryGeneration('u-1', 'b-1');
      await service.runGenerationPipeline('b-1', 'job-1');

      expect(agentService.startBookGeneration).toHaveBeenCalledOnce();
    });
  });

  // ─── getPreviewPdfBuffer ──────────────────────────────────────────────────────

  describe('getPreviewPdfBuffer', () => {
    const PDF_RESULT = {
      buffer: Buffer.from('%PDF-1.4 test'),
      contentType: 'application/pdf' as const,
      filename: 'storyme-preview-b-1.pdf',
    };

    it('returns PDF buffer for a complete book with previewPdfUrl and existing file', async () => {
      const book = makeBook({ previewPdfUrl: '/files/books/b-1/storybook.pdf' });
      prisma.book.findFirst.mockResolvedValue(book);
      pdfStorage.getPreviewPdf.mockResolvedValue(PDF_RESULT);

      const result = await service.getPreviewPdfBuffer('b-1', 'u-1');

      expect(pdfStorage.getPreviewPdf).toHaveBeenCalledWith('b-1');
      expect(result.contentType).toBe('application/pdf');
      expect(result.buffer).toBe(PDF_RESULT.buffer);
      expect(result.filename).toBe('storyme-preview-b-1.pdf');
    });

    it('throws NotFoundException when book does not exist', async () => {
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.getPreviewPdfBuffer('no-such', 'u-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(pdfStorage.getPreviewPdf).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the PDF belongs to a different user — does not leak the file to a cross-user request', async () => {
      // findFirst returns null because the userId filter excludes the row
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.getPreviewPdfBuffer('b-1', 'u-other')).rejects.toThrow(
        NotFoundException,
      );
      expect(pdfStorage.getPreviewPdf).not.toHaveBeenCalled();
    });

    it('throws ConflictException when previewPdfUrl is null', async () => {
      const book = makeBook({ previewPdfUrl: null });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.getPreviewPdfBuffer('b-1', 'u-1')).rejects.toThrow(ConflictException);
      expect(pdfStorage.getPreviewPdf).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when storage returns null (file missing)', async () => {
      const book = makeBook({ previewPdfUrl: '/files/books/b-1/storybook.pdf' });
      prisma.book.findFirst.mockResolvedValue(book);
      pdfStorage.getPreviewPdf.mockResolvedValue(null);

      await expect(service.getPreviewPdfBuffer('b-1', 'u-1')).rejects.toThrow(NotFoundException);
    });

    it('error message for missing file does not contain the absolute path', async () => {
      const book = makeBook({ previewPdfUrl: '/files/books/b-1/storybook.pdf' });
      prisma.book.findFirst.mockResolvedValue(book);
      pdfStorage.getPreviewPdf.mockResolvedValue(null);

      const err = await service.getPreviewPdfBuffer('b-1', 'u-1').catch((e: unknown) => e);
      expect(err instanceof NotFoundException).toBe(true);
      expect(String((err as NotFoundException).message)).not.toMatch(/[A-Za-z]:\\|\/tmp\//);
    });
  });

  // ─── getGenerationDiagnostics ──────────────────────────────────────────────

  describe('getGenerationDiagnostics', () => {
    it('returns diagnostics composed from the owned book and its recent AgentLog rows', async () => {
      const book = makeBook({ status: 'complete' as Book['status'] });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.agentLog.findMany.mockResolvedValue([]);

      const result = await service.getGenerationDiagnostics('b-1', 'u-1');

      expect(prisma.agentLog.findMany).toHaveBeenCalledWith({
        where: { bookId: 'b-1' },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      expect(result.bookId).toBe('b-1');
      expect(result.status).toBe('complete');
    });

    it('throws NotFoundException when the book does not exist or belongs to another user', async () => {
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.getGenerationDiagnostics('b-1', 'u-other')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.agentLog.findMany).not.toHaveBeenCalled();
    });

    it('includes the latest GenerationJob summary via generationJobService.findLatest', async () => {
      const book = makeBook({ status: 'complete' as Book['status'] });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.agentLog.findMany.mockResolvedValue([]);
      generationJobService.findLatest.mockResolvedValue(
        makeGenerationJob({
          id: 'job-9',
          status: 'completed' as GenerationJob['status'],
          attempt: 2,
        }),
      );

      const result = await service.getGenerationDiagnostics('b-1', 'u-1');

      expect(generationJobService.findLatest).toHaveBeenCalledWith('b-1');
      expect(result.latestJob).toMatchObject({ id: 'job-9', status: 'completed', attempt: 2 });
    });

    it('returns latestJob: null when no GenerationJob exists yet for the book', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.agentLog.findMany.mockResolvedValue([]);
      generationJobService.findLatest.mockResolvedValue(null);

      const result = await service.getGenerationDiagnostics('b-1', 'u-1');

      expect(result.latestJob).toBeNull();
    });

    it('reports pdfStorage.keyPresent=false and previewAvailable=false without checking storage when previewPdfUrl is unset', async () => {
      const book = makeBook({ status: STATUS_CHAR_BUILD, previewPdfUrl: null });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.agentLog.findMany.mockResolvedValue([]);

      const result = await service.getGenerationDiagnostics('b-1', 'u-1');

      expect(pdfStorage.previewPdfExists).not.toHaveBeenCalled();
      expect(result.pdfStorage).toEqual({
        driver: 'local',
        keyPresent: false,
        previewAvailable: false,
      });
    });

    it('reports pdfStorage.previewAvailable=true when previewPdfUrl is set and the storage backend confirms the object exists', async () => {
      const book = makeBook({
        status: STATUS_COMPLETE,
        previewPdfUrl: '/files/books/b-1/storybook.pdf',
      });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.agentLog.findMany.mockResolvedValue([]);
      pdfStorage.previewPdfExists.mockResolvedValue(true);

      const result = await service.getGenerationDiagnostics('b-1', 'u-1');

      expect(pdfStorage.previewPdfExists).toHaveBeenCalledWith('b-1');
      expect(result.pdfStorage).toEqual({
        driver: 'local',
        keyPresent: true,
        previewAvailable: true,
      });
    });

    it('reports pdfStorage.previewAvailable=false when previewPdfUrl is set but the storage backend genuinely has no object (the worker/API storage mismatch bug)', async () => {
      const book = makeBook({
        status: STATUS_COMPLETE,
        previewPdfUrl: '/files/books/b-1/storybook.pdf',
      });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.agentLog.findMany.mockResolvedValue([]);
      pdfStorage.previewPdfExists.mockResolvedValue(false);

      const result = await service.getGenerationDiagnostics('b-1', 'u-1');

      expect(result.pdfStorage).toEqual({
        driver: 'local',
        keyPresent: true,
        previewAvailable: false,
      });
    });

    it('surfaces the configured driver name (s3/r2) as-is, never a filesystem path', async () => {
      const book = makeBook({ status: STATUS_COMPLETE });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.agentLog.findMany.mockResolvedValue([]);
      (pdfStorage as unknown as { driver: string }).driver = 's3';

      const result = await service.getGenerationDiagnostics('b-1', 'u-1');

      expect(result.pdfStorage.driver).toBe('s3');
    });

    it('includes queue diagnostics from GenerationQueueService.getQueueDiagnostics', async () => {
      const book = makeBook({ status: STATUS_COMPLETE });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.agentLog.findMany.mockResolvedValue([]);
      generationQueueService.getQueueDiagnostics.mockResolvedValue({
        queueName: 'book-generation',
        workerCount: 2,
        counts: { waiting: 1, active: 1, completed: 5, failed: 0, delayed: 0 },
      });

      const result = await service.getGenerationDiagnostics('b-1', 'u-1');

      expect(result.queue).toMatchObject({
        queueName: 'book-generation',
        workerCount: 2,
        counts: { waiting: 1, active: 1, completed: 5, failed: 0, delayed: 0 },
      });
    });

    it('flags stalledNoWorker=true when the latest job is queued but no worker is connected (the "stuck in char_build" signature)', async () => {
      const book = makeBook({ status: STATUS_CHAR_BUILD });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.agentLog.findMany.mockResolvedValue([]);
      generationJobService.findLatest.mockResolvedValue(
        makeGenerationJob({ status: 'queued' as GenerationJob['status'] }),
      );
      generationQueueService.getQueueDiagnostics.mockResolvedValue({
        queueName: 'book-generation',
        workerCount: 0,
        counts: { waiting: 1, active: 0, completed: 0, failed: 0, delayed: 0 },
      });

      const result = await service.getGenerationDiagnostics('b-1', 'u-1');

      expect(result.queue.stalledNoWorker).toBe(true);
    });

    it('flags stalledNoWorker=false when a worker is connected even if a job is still queued', async () => {
      const book = makeBook({ status: STATUS_CHAR_BUILD });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.agentLog.findMany.mockResolvedValue([]);
      generationJobService.findLatest.mockResolvedValue(
        makeGenerationJob({ status: 'queued' as GenerationJob['status'] }),
      );
      generationQueueService.getQueueDiagnostics.mockResolvedValue({
        queueName: 'book-generation',
        workerCount: 1,
        counts: { waiting: 1, active: 0, completed: 0, failed: 0, delayed: 0 },
      });

      const result = await service.getGenerationDiagnostics('b-1', 'u-1');

      expect(result.queue.stalledNoWorker).toBe(false);
    });
  });
});
