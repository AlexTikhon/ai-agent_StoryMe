import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Book, type GenerationJob, type GenerationRun } from '@prisma/client';
import { BooksService } from './books.service';
import type { AgentService } from '../agent/agent.service';
import type { GenerationQueueService } from '../agent/generation-queue.service';
import type { GenerationJobService } from '../agent/generation-job.service';
import type { GenerationRunService } from '../agent/generation-run.service';
import type { PdfStorage } from '../pdf/pdf-storage';
import type { ImageAssetStorage } from '../images/image-asset-storage';
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

function createMockImageAssetStorage(): jest.Mocked<ImageAssetStorage> {
  return {
    saveImageAsset: vi.fn().mockResolvedValue({ key: 'k', path: 'p', contentType: 'image/png' }),
    getImageAsset: vi.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ImageAssetStorage>;
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

/** Simulates the P2002 Postgres raises for the hand-added `generation_runs_one_active_per_book` partial unique index — see isOneActiveRunViolation in books.service.ts. */
function oneActiveRunViolationError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed.', {
    code: 'P2002',
    clientVersion: '5.17.0',
    meta: { modelName: 'GenerationRun', target: ['book_id'] },
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
    countActiveForUser: vi.fn().mockResolvedValue(0),
    countCreatedForUserSince: vi.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<GenerationJobService>;
}

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

function createMockGenerationRunService(): jest.Mocked<GenerationRunService> {
  return {
    findActiveForBook: vi.fn().mockResolvedValue(null),
    // Defaults to "no prior run" — retryGeneration's legacy fallback path
    // (build a fresh snapshot from the book's current fields), which keeps
    // most retryGeneration tests' assertions unaffected by run history.
    // Tests specifically covering "retry copies the prior run's exact
    // inputSnapshot" override this explicitly.
    findLatestForBook: vi.fn().mockResolvedValue(null),
    countActiveForUser: vi.fn().mockResolvedValue(0),
    countCreatedForUserSince: vi.fn().mockResolvedValue(0),
    claim: vi.fn().mockResolvedValue(makeGenerationRun({ status: 'running' as GenerationRun['status'] })),
  } as unknown as jest.Mocked<GenerationRunService>;
}

const GENERATION_GUARD_ENV = {
  GLOBAL_GENERATION_CIRCUIT_WINDOW_MS: 60_000,
  GLOBAL_GENERATION_CIRCUIT_MAX_PER_WINDOW: 100,
  MAX_CONCURRENT_GENERATIONS_PER_USER: 2,
  GENERATION_USER_WINDOW_MS: 86_400_000,
  MAX_GENERATIONS_PER_USER_PER_WINDOW: 20,
} as const;

function createMockConfig(overrides: Partial<typeof GENERATION_GUARD_ENV> = {}) {
  const values: Record<string, number> = { ...GENERATION_GUARD_ENV, ...overrides };
  return { get: (key: string) => values[key] } as never;
}

function createMockRateLimiter(allowed = true) {
  return {
    consume: vi.fn().mockResolvedValue({ allowed, remaining: allowed ? 99 : 0, retryAfterMs: 1000 }),
  } as never;
}

function createMockChildPhotoProcessor() {
  return {
    process: vi
      .fn()
      .mockResolvedValue({ buffer: Buffer.from('processed-bytes'), contentType: 'image/jpeg' }),
  } as never;
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
    childPhotoAssetKey: null,
    childPhotoContentType: null,
    characterProfile: null,
    characterSheetAssetKey: null,
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
  let imageAssetStorage: ReturnType<typeof createMockImageAssetStorage>;
  let generationQueueService: ReturnType<typeof createMockGenerationQueueService>;
  let generationJobService: ReturnType<typeof createMockGenerationJobService>;
  let generationRunService: ReturnType<typeof createMockGenerationRunService>;
  let config: ReturnType<typeof createMockConfig>;
  let rateLimiter: ReturnType<typeof createMockRateLimiter>;
  let childPhotoProcessor: ReturnType<typeof createMockChildPhotoProcessor>;

  beforeEach(() => {
    prisma = createMockPrisma();
    // Interactive-transaction test double: runs the callback against the
    // same mocked model methods the rest of the suite already configures, so
    // `tx.generationRun.create`/`tx.book.update`/`tx.outboxEvent.create`
    // inside BooksService.createRunAndSchedule behave exactly like their
    // non-transactional counterparts in these tests.
    prisma.$transaction.mockImplementation((cb: (tx: MockPrisma) => unknown) => cb(prisma));
    prisma.generationRun.create.mockResolvedValue(makeGenerationRun());
    prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.book.updateMany.mockResolvedValue({ count: 1 });
    prisma.outboxEvent.create.mockResolvedValue({
      id: 'outbox-1',
      aggregateType: 'generation_run',
      aggregateId: 'run-1',
      eventType: 'run_queued',
      payload: { bookId: 'b-1', runId: 'run-1' },
      status: 'pending',
      attempts: 0,
      createdAt: new Date('2026-01-01'),
      dispatchedAt: null,
    });
    agentService = createMockAgentService();
    pdfStorage = createMockPdfStorage();
    imageAssetStorage = createMockImageAssetStorage();
    generationQueueService = createMockGenerationQueueService();
    generationJobService = createMockGenerationJobService();
    generationRunService = createMockGenerationRunService();
    config = createMockConfig();
    rateLimiter = createMockRateLimiter();
    childPhotoProcessor = createMockChildPhotoProcessor();
    service = new BooksService(
      prisma as never,
      agentService as never,
      pdfStorage as never,
      imageAssetStorage as never,
      generationQueueService as never,
      generationJobService as never,
      generationRunService as never,
      config,
      rateLimiter,
      childPhotoProcessor,
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

  // ─── uploadChildPhoto ────────────────────────────────────────────────────────

  describe('uploadChildPhoto', () => {
    function makeFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
      return {
        fieldname: 'photo',
        originalname: 'child.jpg',
        encoding: '7bit',
        mimetype: 'image/jpeg',
        size: 1024,
        buffer: Buffer.from('fake-jpeg-bytes'),
        stream: undefined as never,
        destination: '',
        filename: '',
        path: '',
        ...overrides,
      };
    }

    it('decodes/re-encodes the file via ChildPhotoProcessor before saving, and persists the processor-reported content type', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      const updated = makeBook({
        status: STATUS_CREATED,
        childPhotoAssetKey: 'b-1/child-photo',
        childPhotoContentType: 'image/jpeg',
      });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(updated);
      const rawFile = makeFile({ mimetype: 'image/png' }); // claimed type — must not be trusted
      const processedBuffer = Buffer.from('processed-bytes');
      childPhotoProcessor.process.mockResolvedValue({
        buffer: processedBuffer,
        contentType: 'image/jpeg',
      });

      const result = await service.uploadChildPhoto('u-1', 'b-1', rawFile);

      expect(childPhotoProcessor.process).toHaveBeenCalledWith(rawFile.buffer);
      expect(imageAssetStorage.saveImageAsset).toHaveBeenCalledWith(
        'b-1/child-photo',
        processedBuffer,
        'image/jpeg',
      );
      expect(prisma.book.update).toHaveBeenCalledWith({
        where: { id: 'b-1' },
        data: { childPhotoAssetKey: 'b-1/child-photo', childPhotoContentType: 'image/jpeg' },
      });
      expect(result.characterProfile).toBeNull();
    });

    it('propagates a BadRequestException from ChildPhotoProcessor (undecodable bytes / unsupported format / oversized) without saving anything', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      prisma.book.findFirst.mockResolvedValue(book);
      childPhotoProcessor.process.mockRejectedValue(
        new BadRequestException('The uploaded file could not be decoded as an image'),
      );

      await expect(service.uploadChildPhoto('u-1', 'b-1', makeFile())).rejects.toThrow(
        BadRequestException,
      );
      expect(imageAssetStorage.saveImageAsset).not.toHaveBeenCalled();
      expect(prisma.book.update).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when no file is provided (multer rejected it)', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.uploadChildPhoto('u-1', 'b-1', undefined)).rejects.toThrow(
        BadRequestException,
      );
      expect(imageAssetStorage.saveImageAsset).not.toHaveBeenCalled();
    });

    it('throws ConflictException when generation is already in progress', async () => {
      const book = makeBook({ status: STATUS_IN_PROGRESS });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.uploadChildPhoto('u-1', 'b-1', makeFile())).rejects.toThrow(
        ConflictException,
      );
      expect(imageAssetStorage.saveImageAsset).not.toHaveBeenCalled();
    });

    it('allows re-uploading a photo for a complete book ahead of a regenerate', async () => {
      const book = makeBook({ status: STATUS_COMPLETE });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(book);

      await expect(service.uploadChildPhoto('u-1', 'b-1', makeFile())).resolves.toBeDefined();
    });

    it('throws NotFoundException when the book does not exist or belongs to another user', async () => {
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.uploadChildPhoto('u-other', 'b-1', makeFile())).rejects.toThrow(
        NotFoundException,
      );
      expect(imageAssetStorage.saveImageAsset).not.toHaveBeenCalled();
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
    it('transitions status to char_build, sets activeRunId, and returns quickly, without waiting for the pipeline', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      const started = makeBook({ status: STATUS_CHAR_BUILD, activeRunId: 'run-1' });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(started);

      const result = await service.startGeneration('u-1', 'b-1');

      expect(prisma.book.update).toHaveBeenCalledWith({
        where: { id: 'b-1', status: STATUS_CREATED },
        data: { status: 'char_build', activeRunId: 'run-1', failedStep: null, errorMessage: null },
      });
      expect(result.book.status).toBe('char_build');
      expect(result.book.id).toBe('b-1');
      // The pipeline itself is scheduled in the background, not awaited here.
      expect(agentService.startBookGeneration).not.toHaveBeenCalled();
    });

    it('creates a GenerationRun (kind initial) and an OutboxEvent, all inside one transaction', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      const started = makeBook({ status: STATUS_CHAR_BUILD, activeRunId: 'run-1' });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(started);

      await service.startGeneration('u-1', 'b-1');

      expect(prisma.$transaction).toHaveBeenCalledOnce();
      expect(prisma.generationRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          bookId: 'b-1',
          userId: 'u-1',
          kind: 'initial',
          inputSnapshot: expect.objectContaining({ childName: 'Mia', theme: 'friendship' }),
          inputHash: expect.any(String),
        }),
      });
      expect(prisma.outboxEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          aggregateType: 'generation_run',
          aggregateId: 'run-1',
          eventType: 'run_queued',
          payload: { bookId: 'b-1', runId: 'run-1' },
        }),
      });
      // The BullMQ publish itself is NOT done here — OutboxDispatcherService
      // does that from the committed OutboxEvent, so a crash right after this
      // transaction commits can never lose the dispatch.
      expect(generationQueueService.enqueue).not.toHaveBeenCalled();
    });

    it('logs the status transition from created to char_build', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const book = makeBook({ status: STATUS_CREATED });
      const started = makeBook({ status: STATUS_CHAR_BUILD, activeRunId: 'run-1' });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(started);

      await service.startGeneration('u-1', 'b-1');

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`${STATUS_CREATED} -> char_build`));
      logSpy.mockRestore();
    });

    it('creates a queued GenerationJob (type generate, attempt 1) as a best-effort legacy diagnostics mirror', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      const started = makeBook({ status: STATUS_CHAR_BUILD, activeRunId: 'run-1' });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(started);

      await service.startGeneration('u-1', 'b-1');

      expect(generationJobService.createQueued).toHaveBeenCalledWith({
        bookId: 'b-1',
        userId: 'u-1',
        type: 'generate',
        attempt: 1,
      });
    });

    it('does not fail the request if the legacy GenerationJob mirror write fails', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      const started = makeBook({ status: STATUS_CHAR_BUILD, activeRunId: 'run-1' });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(started);
      generationJobService.createQueued.mockRejectedValue(new Error('legacy diagnostics DB blip'));

      await expect(service.startGeneration('u-1', 'b-1')).resolves.toBeDefined();
    });

    it('throws ConflictException when an active GenerationRun already exists for the book', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      prisma.book.findFirst.mockResolvedValue(book);
      generationRunService.findActiveForBook.mockResolvedValue(
        makeGenerationRun({ status: 'running' as GenerationRun['status'] }),
      );

      await expect(service.startGeneration('u-1', 'b-1')).rejects.toThrow(ConflictException);
      expect(prisma.book.update).not.toHaveBeenCalled();
      expect(prisma.generationRun.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when book does not exist', async () => {
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.startGeneration('u-1', 'no-such')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when book belongs to a different user', async () => {
      // findFirst returns null because userId filter excludes the row
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.startGeneration('u-other', 'b-1')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException for a soft-deleted book', async () => {
      // findOwnedOrThrow filters deletedAt: null — deleted books appear as not found
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.startGeneration('u-1', 'b-deleted')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when childName is missing', async () => {
      const book = makeBook({ childName: null });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.startGeneration('u-1', 'b-1')).rejects.toThrow(BadRequestException);
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
    });

    describe('concurrency', () => {
      it('throws ConflictException (and never schedules a job) when a concurrent request already won the Book status transition (P2025)', async () => {
        // Both requests pass the pre-checks (findFirst still sees `created`),
        // but the conditional UPDATE's WHERE clause loses the race — Prisma
        // reports zero matching rows as a P2025 "record not found" error.
        const book = makeBook({ status: STATUS_CREATED });
        prisma.book.findFirst.mockResolvedValue(book);
        prisma.book.update.mockRejectedValue(recordNotFoundError());

        await expect(service.startGeneration('u-1', 'b-1')).rejects.toThrow(ConflictException);
        expect(generationJobService.createQueued).not.toHaveBeenCalled();
      });

      it('throws ConflictException when two concurrent calls both pass the pre-check and race on the DB-level one-active-run index (P2002)', async () => {
        const book = makeBook({ status: STATUS_CREATED });
        prisma.book.findFirst.mockResolvedValue(book);
        prisma.generationRun.create.mockRejectedValue(oneActiveRunViolationError());

        await expect(service.startGeneration('u-1', 'b-1')).rejects.toThrow(ConflictException);
        expect(prisma.book.update).not.toHaveBeenCalled();
        expect(generationJobService.createQueued).not.toHaveBeenCalled();
      });

      it('re-throws unrelated prisma errors from the transaction instead of masking them as a conflict', async () => {
        const book = makeBook({ status: STATUS_CREATED });
        prisma.book.findFirst.mockResolvedValue(book);
        prisma.book.update.mockRejectedValue(new Error('connection reset'));

        await expect(service.startGeneration('u-1', 'b-1')).rejects.toThrow('connection reset');
        expect(generationJobService.createQueued).not.toHaveBeenCalled();
      });
    });

    describe('generation guards (assertGenerationAllowed)', () => {
      it('throws ServiceUnavailableException when the global circuit breaker is tripped, before touching Book.status', async () => {
        const book = makeBook({ status: STATUS_CREATED });
        prisma.book.findFirst.mockResolvedValue(book);
        rateLimiter.consume.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 5000 });

        await expect(service.startGeneration('u-1', 'b-1')).rejects.toMatchObject({
          status: 503,
          response: expect.objectContaining({ code: 'GENERATION_CAPACITY_EXCEEDED' }),
        });
        expect(prisma.book.update).not.toHaveBeenCalled();
        expect(generationJobService.createQueued).not.toHaveBeenCalled();
      });

      it('throws ConflictException with GENERATION_CONCURRENCY_LIMIT when the user is at their concurrent-generation cap', async () => {
        const book = makeBook({ status: STATUS_CREATED });
        prisma.book.findFirst.mockResolvedValue(book);
        generationRunService.countActiveForUser.mockResolvedValue(2);

        await expect(service.startGeneration('u-1', 'b-1')).rejects.toMatchObject({
          response: expect.objectContaining({ code: 'GENERATION_CONCURRENCY_LIMIT' }),
        });
        expect(prisma.book.update).not.toHaveBeenCalled();
      });

      it('throws 429 with GENERATION_QUOTA_EXCEEDED when the user is at their rolling-window generation cap', async () => {
        const book = makeBook({ status: STATUS_CREATED });
        prisma.book.findFirst.mockResolvedValue(book);
        generationRunService.countCreatedForUserSince.mockResolvedValue(20);

        await expect(service.startGeneration('u-1', 'b-1')).rejects.toMatchObject({
          status: 429,
          response: expect.objectContaining({ code: 'GENERATION_QUOTA_EXCEEDED' }),
        });
        expect(prisma.book.update).not.toHaveBeenCalled();
      });

      it('allows generation through when all three guards pass', async () => {
        const book = makeBook({ status: STATUS_CREATED });
        const started = makeBook({ status: STATUS_CHAR_BUILD, activeRunId: 'run-1' });
        prisma.book.findFirst.mockResolvedValue(book);
        prisma.book.update.mockResolvedValue(started);

        await expect(service.startGeneration('u-1', 'b-1')).resolves.toBeDefined();
        expect(rateLimiter.consume).toHaveBeenCalledWith(
          'global-generation-circuit',
          GENERATION_GUARD_ENV.GLOBAL_GENERATION_CIRCUIT_WINDOW_MS,
          GENERATION_GUARD_ENV.GLOBAL_GENERATION_CIRCUIT_MAX_PER_WINDOW,
        );
        expect(generationRunService.countActiveForUser).toHaveBeenCalledWith('u-1');
        expect(generationRunService.countCreatedForUserSince).toHaveBeenCalledWith(
          'u-1',
          expect.any(Date),
        );
      });
    });
  });

  // ─── retryGeneration ─────────────────────────────────────────────────────────

  describe('retryGeneration', () => {
    it('clears failedStep/errorMessage, transitions to char_build, sets activeRunId, and returns quickly', async () => {
      const book = makeBook({
        status: STATUS_FAILED,
        failedStep: 'pdf_render' as Book['failedStep'],
        errorMessage: 'PDF render failed',
      });
      const cleared = makeBook({
        status: STATUS_CHAR_BUILD,
        failedStep: null,
        errorMessage: null,
        activeRunId: 'run-1',
      });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);

      const result = await service.retryGeneration('u-1', 'b-1');

      expect(prisma.book.update).toHaveBeenCalledWith({
        where: { id: 'b-1', status: STATUS_FAILED },
        data: {
          status: 'char_build',
          activeRunId: 'run-1',
          failedStep: null,
          errorMessage: null,
          retryCount: { increment: 1 },
        },
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
      const cleared = makeBook({
        status: STATUS_CHAR_BUILD,
        failedStep: null,
        errorMessage: null,
        activeRunId: 'run-1',
      });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);

      const result = await service.retryGeneration('u-1', 'b-1');

      expect(result.book.status).toBe('char_build');
      expect(prisma.outboxEvent.create).toHaveBeenCalledOnce();
    });

    it('creates a GenerationRun (kind retry) inside the transaction', async () => {
      const book = makeBook({ status: STATUS_FAILED });
      const cleared = makeBook({
        status: STATUS_CHAR_BUILD,
        failedStep: null,
        errorMessage: null,
        activeRunId: 'run-1',
      });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);

      await service.retryGeneration('u-1', 'b-1');

      expect(prisma.generationRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ bookId: 'b-1', userId: 'u-1', kind: 'retry' }),
      });
    });

    it('creates a retry GenerationJob (legacy mirror) with attempt incremented past the post-increment retryCount', async () => {
      const book = makeBook({ status: STATUS_FAILED });
      // retryCount is already incremented by the prisma.book.update mock below.
      const cleared = makeBook({
        status: STATUS_CHAR_BUILD,
        failedStep: null,
        errorMessage: null,
        retryCount: 1,
        activeRunId: 'run-1',
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

    it('throws ConflictException when an active GenerationRun already exists for the book', async () => {
      const book = makeBook({ status: STATUS_FAILED });
      prisma.book.findFirst.mockResolvedValue(book);
      generationRunService.findActiveForBook.mockResolvedValue(
        makeGenerationRun({ status: 'queued' as GenerationRun['status'] }),
      );

      await expect(service.retryGeneration('u-1', 'b-1')).rejects.toThrow(ConflictException);
      expect(prisma.book.update).not.toHaveBeenCalled();
    });

    it('allows retry when the book is failed and no active run exists (a prior completed/failed run does not block it)', async () => {
      const book = makeBook({ status: STATUS_FAILED });
      const cleared = makeBook({
        status: STATUS_CHAR_BUILD,
        failedStep: null,
        errorMessage: null,
        activeRunId: 'run-1',
      });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);
      generationRunService.findActiveForBook.mockResolvedValue(null);

      await expect(service.retryGeneration('u-1', 'b-1')).resolves.toBeDefined();
    });

    it('throws ConflictException when the book is not failed (e.g. still generating)', async () => {
      const book = makeBook({ status: STATUS_IN_PROGRESS });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.retryGeneration('u-1', 'b-1')).rejects.toThrow(ConflictException);
      expect(prisma.book.update).not.toHaveBeenCalled();
    });

    it('throws ConflictException for a complete book — use regenerateBook instead', async () => {
      const book = makeBook({ status: STATUS_COMPLETE });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.retryGeneration('u-1', 'b-1')).rejects.toThrow(ConflictException);
      expect(prisma.book.update).not.toHaveBeenCalled();
    });

    it('copies the prior run inputSnapshot verbatim and links retryOfRunId, ignoring the book row current fields', async () => {
      const book = makeBook({ status: STATUS_FAILED, theme: 'edited-after-failure-theme' });
      const cleared = makeBook({ status: STATUS_CHAR_BUILD, activeRunId: 'run-1' });
      const priorSnapshot = { childName: 'Mia', childAge: 5, language: 'en', theme: 'original-theme', educationalMessage: null, pageCount: null, childPhotoAssetKey: null, childPhotoContentType: null };
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);
      generationRunService.findLatestForBook.mockResolvedValue(
        makeGenerationRun({ id: 'prior-run-1', inputSnapshot: priorSnapshot }),
      );

      await service.retryGeneration('u-1', 'b-1');

      expect(prisma.generationRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          kind: 'retry',
          inputSnapshot: priorSnapshot,
          retryOfRunId: 'prior-run-1',
        }),
      });
    });

    it('falls back to building a fresh snapshot from the book row when no prior run exists (legacy book)', async () => {
      const book = makeBook({ status: STATUS_FAILED, theme: 'friendship' });
      const cleared = makeBook({ status: STATUS_CHAR_BUILD, activeRunId: 'run-1' });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);
      generationRunService.findLatestForBook.mockResolvedValue(null);

      await service.retryGeneration('u-1', 'b-1');

      expect(prisma.generationRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          inputSnapshot: expect.objectContaining({ theme: 'friendship' }),
        }),
      });
      const createCall = prisma.generationRun.create.mock.calls[0]?.[0] as { data: { retryOfRunId?: string } };
      expect(createCall.data.retryOfRunId).toBeUndefined();
    });

    describe('concurrency', () => {
      it('throws ConflictException (and never schedules a job) when a concurrent retry already won the Book status transition (P2025)', async () => {
        const book = makeBook({ status: STATUS_FAILED });
        prisma.book.findFirst.mockResolvedValue(book);
        prisma.book.update.mockRejectedValue(recordNotFoundError());

        await expect(service.retryGeneration('u-1', 'b-1')).rejects.toThrow(ConflictException);
        expect(generationJobService.createQueued).not.toHaveBeenCalled();
      });

      it('throws ConflictException when two concurrent retries race on the DB-level one-active-run index (P2002)', async () => {
        const book = makeBook({ status: STATUS_FAILED });
        prisma.book.findFirst.mockResolvedValue(book);
        prisma.generationRun.create.mockRejectedValue(oneActiveRunViolationError());

        await expect(service.retryGeneration('u-1', 'b-1')).rejects.toThrow(ConflictException);
        expect(prisma.book.update).not.toHaveBeenCalled();
      });
    });

    describe('generation guards (assertGenerationAllowed)', () => {
      it('throws ServiceUnavailableException when the global circuit breaker is tripped, before touching Book.status', async () => {
        const book = makeBook({ status: STATUS_FAILED });
        prisma.book.findFirst.mockResolvedValue(book);
        rateLimiter.consume.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 5000 });

        await expect(service.retryGeneration('u-1', 'b-1')).rejects.toMatchObject({
          status: 503,
          response: expect.objectContaining({ code: 'GENERATION_CAPACITY_EXCEEDED' }),
        });
        expect(prisma.book.update).not.toHaveBeenCalled();
      });

      it('throws ConflictException with GENERATION_CONCURRENCY_LIMIT when the user is at their concurrent-generation cap', async () => {
        const book = makeBook({ status: STATUS_FAILED });
        prisma.book.findFirst.mockResolvedValue(book);
        generationRunService.countActiveForUser.mockResolvedValue(2);

        await expect(service.retryGeneration('u-1', 'b-1')).rejects.toMatchObject({
          response: expect.objectContaining({ code: 'GENERATION_CONCURRENCY_LIMIT' }),
        });
        expect(prisma.book.update).not.toHaveBeenCalled();
      });

      it('throws 429 with GENERATION_QUOTA_EXCEEDED when the user is at their rolling-window generation cap', async () => {
        const book = makeBook({ status: STATUS_FAILED });
        prisma.book.findFirst.mockResolvedValue(book);
        generationRunService.countCreatedForUserSince.mockResolvedValue(20);

        await expect(service.retryGeneration('u-1', 'b-1')).rejects.toMatchObject({
          status: 429,
          response: expect.objectContaining({ code: 'GENERATION_QUOTA_EXCEEDED' }),
        });
        expect(prisma.book.update).not.toHaveBeenCalled();
      });
    });

    it('throws NotFoundException when the book belongs to a different user', async () => {
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.retryGeneration('u-other', 'b-1')).rejects.toThrow(NotFoundException);
      expect(prisma.book.update).not.toHaveBeenCalled();
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
  });

  // ─── regenerateBook ──────────────────────────────────────────────────────────

  describe('regenerateBook', () => {
    it('regenerates a complete book, building a fresh inputSnapshot from the book row current fields', async () => {
      const book = makeBook({ status: STATUS_COMPLETE, theme: 'edited-theme' });
      const cleared = makeBook({ status: STATUS_CHAR_BUILD, activeRunId: 'run-1' });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);

      const result = await service.regenerateBook('u-1', 'b-1');

      expect(prisma.book.update).toHaveBeenCalledWith({
        where: { id: 'b-1', status: STATUS_COMPLETE },
        data: expect.objectContaining({ status: 'char_build', activeRunId: 'run-1' }),
      });
      expect(prisma.generationRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          kind: 'regenerate',
          inputSnapshot: expect.objectContaining({ theme: 'edited-theme' }),
        }),
      });
      expect(result.book.status).toBe('char_build');
    });

    it('regenerates a failed book too (not just complete)', async () => {
      const book = makeBook({ status: STATUS_FAILED });
      const cleared = makeBook({ status: STATUS_CHAR_BUILD, activeRunId: 'run-1' });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);

      await expect(service.regenerateBook('u-1', 'b-1')).resolves.toBeDefined();
      expect(prisma.generationRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ kind: 'regenerate' }),
      });
    });

    it('never links retryOfRunId — a regenerate always starts a fresh lineage', async () => {
      const book = makeBook({ status: STATUS_COMPLETE });
      const cleared = makeBook({ status: STATUS_CHAR_BUILD, activeRunId: 'run-1' });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);
      generationRunService.findLatestForBook.mockResolvedValue(makeGenerationRun({ id: 'some-prior-run' }));

      await service.regenerateBook('u-1', 'b-1');

      const createCall = prisma.generationRun.create.mock.calls[0]?.[0] as { data: { retryOfRunId?: string } };
      expect(createCall.data.retryOfRunId).toBeUndefined();
      // regenerateBook never even needs to look up run history, unlike retryGeneration.
      expect(generationRunService.findLatestForBook).not.toHaveBeenCalled();
    });

    it('throws ConflictException when the book is neither failed nor complete (e.g. still generating)', async () => {
      const book = makeBook({ status: STATUS_IN_PROGRESS });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.regenerateBook('u-1', 'b-1')).rejects.toThrow(ConflictException);
      expect(prisma.book.update).not.toHaveBeenCalled();
    });

    it('throws ConflictException when an active GenerationRun already exists for the book', async () => {
      const book = makeBook({ status: STATUS_COMPLETE });
      prisma.book.findFirst.mockResolvedValue(book);
      generationRunService.findActiveForBook.mockResolvedValue(
        makeGenerationRun({ status: 'running' as GenerationRun['status'] }),
      );

      await expect(service.regenerateBook('u-1', 'b-1')).rejects.toThrow(ConflictException);
      expect(prisma.book.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the book does not exist', async () => {
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.regenerateBook('u-1', 'no-such')).rejects.toThrow(NotFoundException);
    });

    describe('generation guards (assertGenerationAllowed)', () => {
      it('throws ServiceUnavailableException when the global circuit breaker is tripped', async () => {
        const book = makeBook({ status: STATUS_COMPLETE });
        prisma.book.findFirst.mockResolvedValue(book);
        rateLimiter.consume.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 5000 });

        await expect(service.regenerateBook('u-1', 'b-1')).rejects.toMatchObject({
          status: 503,
          response: expect.objectContaining({ code: 'GENERATION_CAPACITY_EXCEEDED' }),
        });
        expect(prisma.book.update).not.toHaveBeenCalled();
      });
    });
  });

  // ─── runGenerationPipeline ────────────────────────────────────────────────────

  describe('runGenerationPipeline', () => {
    it('calls AgentService.startBookGeneration with the freshly-loaded book and the claimed run inputHash', async () => {
      const claimed = makeGenerationRun({ status: 'running' as GenerationRun['status'], inputHash: 'run-input-hash' });
      const book = makeBook({ status: STATUS_CHAR_BUILD });
      prisma.book.findUniqueOrThrow.mockResolvedValue(book);
      agentService.startBookGeneration.mockResolvedValue(makeBook({ status: STATUS_COMPLETE }));

      await service.runGenerationPipeline('b-1', claimed);

      expect(prisma.book.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 'b-1' } });
      expect(agentService.startBookGeneration).toHaveBeenCalledOnce();
      expect(agentService.startBookGeneration).toHaveBeenCalledWith(book, 'run-input-hash');
    });

    it('reuses AgentService.startBookGeneration rather than duplicating pipeline logic', async () => {
      const claimed = makeGenerationRun({ status: 'running' as GenerationRun['status'] });
      prisma.book.findUniqueOrThrow.mockResolvedValue(makeBook({ status: STATUS_CHAR_BUILD }));
      agentService.startBookGeneration.mockResolvedValue(makeBook({ status: STATUS_COMPLETE }));

      await service.runGenerationPipeline('b-1', claimed);

      expect(agentService.startBookGeneration).toHaveBeenCalledOnce();
    });

    it('on success: marks the run completed, clears Book.activeRunId, and sets Book.publishedRunId — guarded on the claimed fencingVersion', async () => {
      const claimed = makeGenerationRun({ id: 'run-1', bookId: 'b-1', fencingVersion: 3, status: 'running' as GenerationRun['status'] });
      prisma.book.findUniqueOrThrow.mockResolvedValue(makeBook({ status: STATUS_CHAR_BUILD }));
      agentService.startBookGeneration.mockResolvedValue(makeBook({ status: STATUS_COMPLETE }));
      prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });

      await service.runGenerationPipeline('b-1', claimed);

      expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
        where: { id: 'run-1', status: 'running', fencingVersion: 3 },
        data: { status: 'completed', completedAt: expect.any(Date) },
      });
      expect(prisma.book.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', activeRunId: 'run-1' },
        data: { activeRunId: null, publishedRunId: 'run-1' },
      });
    });

    it('on success: marks the legacy GenerationJob completed when one exists', async () => {
      const claimed = makeGenerationRun({ status: 'running' as GenerationRun['status'] });
      prisma.book.findUniqueOrThrow.mockResolvedValue(makeBook({ status: STATUS_CHAR_BUILD }));
      agentService.startBookGeneration.mockResolvedValue(makeBook({ status: STATUS_COMPLETE }));
      generationJobService.findActive.mockResolvedValue(makeGenerationJob());
      prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });

      await service.runGenerationPipeline('b-1', claimed);

      expect(generationJobService.markRunning).toHaveBeenCalledWith('job-1');
      expect(generationJobService.markCompleted).toHaveBeenCalledWith('job-1');
      expect(generationJobService.markFailed).not.toHaveBeenCalled();
    });

    it('logs the book status transition (e.g. char_build -> complete)', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const claimed = makeGenerationRun({ status: 'running' as GenerationRun['status'] });
      prisma.book.findUniqueOrThrow.mockResolvedValue(makeBook({ status: STATUS_CHAR_BUILD }));
      agentService.startBookGeneration.mockResolvedValue(makeBook({ status: STATUS_COMPLETE }));
      prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });

      await service.runGenerationPipeline('b-1', claimed);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('char_build -> complete'));
      logSpy.mockRestore();
    });

    it('on an expected content failure (AgentService returns status=failed): marks the run failed with a safe errorCode, without touching Book.status (AgentService already wrote it)', async () => {
      const claimed = makeGenerationRun({ id: 'run-1', bookId: 'b-1', fencingVersion: 0, status: 'running' as GenerationRun['status'] });
      prisma.book.findUniqueOrThrow.mockResolvedValue(makeBook({ status: STATUS_CHAR_BUILD }));
      agentService.startBookGeneration.mockResolvedValue(
        makeBook({
          status: STATUS_FAILED,
          failedStep: 'image_gen' as Book['failedStep'],
          errorMessage: 'OpenAI image request failed',
        }),
      );
      prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });

      await service.runGenerationPipeline('b-1', claimed);

      expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
        where: { id: 'run-1', status: 'running', fencingVersion: 0 },
        data: {
          status: 'failed',
          failedAt: expect.any(Date),
          errorCode: 'GENERATION_FAILED',
          errorMessage: 'OpenAI image request failed',
        },
      });
      expect(prisma.book.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', activeRunId: 'run-1' },
        data: { activeRunId: null },
      });
    });

    it('on an expected content failure: marks the legacy GenerationJob failed (with failedStep/errorMessage) when one exists', async () => {
      const claimed = makeGenerationRun({ status: 'running' as GenerationRun['status'] });
      prisma.book.findUniqueOrThrow.mockResolvedValue(makeBook({ status: STATUS_CHAR_BUILD }));
      agentService.startBookGeneration.mockResolvedValue(
        makeBook({
          status: STATUS_FAILED,
          failedStep: 'image_gen' as Book['failedStep'],
          errorMessage: 'OpenAI image request failed',
        }),
      );
      generationJobService.findActive.mockResolvedValue(makeGenerationJob());
      prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });

      await service.runGenerationPipeline('b-1', claimed);

      expect(generationJobService.markFailed).toHaveBeenCalledWith('job-1', {
        errorMessage: 'OpenAI image request failed',
        failedStep: 'image_gen',
      });
      expect(generationJobService.markCompleted).not.toHaveBeenCalled();
    });

    it('completeRun is a no-op on Book when the fencing guard finds the run already superseded', async () => {
      const claimed = makeGenerationRun({ id: 'run-1', bookId: 'b-1', fencingVersion: 1, status: 'running' as GenerationRun['status'] });
      prisma.book.findUniqueOrThrow.mockResolvedValue(makeBook({ status: STATUS_CHAR_BUILD }));
      agentService.startBookGeneration.mockResolvedValue(makeBook({ status: STATUS_COMPLETE }));
      // Recovery (or a later claim) already moved the run on — updateMany matches 0 rows.
      prisma.generationRun.updateMany.mockResolvedValue({ count: 0 });

      await service.runGenerationPipeline('b-1', claimed);

      expect(prisma.book.updateMany).not.toHaveBeenCalled();
    });

    it('on an unexpected/transient error: does not touch GenerationRun or Book, and rethrows so BullMQ retries', async () => {
      const claimed = makeGenerationRun({ status: 'running' as GenerationRun['status'] });
      prisma.book.findUniqueOrThrow.mockResolvedValue(makeBook({ status: STATUS_CHAR_BUILD }));
      agentService.startBookGeneration.mockRejectedValue(new Error('unexpected pipeline crash'));

      await expect(service.runGenerationPipeline('b-1', claimed)).rejects.toThrow(
        'unexpected pipeline crash',
      );

      expect(prisma.generationRun.updateMany).not.toHaveBeenCalled();
      expect(prisma.book.update).not.toHaveBeenCalled();
      expect(prisma.book.updateMany).not.toHaveBeenCalled();
    });

    it('on an unexpected/transient error: marks the legacy GenerationJob failed (best-effort) but still rethrows', async () => {
      const claimed = makeGenerationRun({ status: 'running' as GenerationRun['status'] });
      prisma.book.findUniqueOrThrow.mockResolvedValue(makeBook({ status: STATUS_CHAR_BUILD }));
      agentService.startBookGeneration.mockRejectedValue(new Error('unexpected pipeline crash'));
      generationJobService.findActive.mockResolvedValue(makeGenerationJob());

      await expect(service.runGenerationPipeline('b-1', claimed)).rejects.toThrow();

      expect(generationJobService.markFailed).toHaveBeenCalledWith('job-1', {
        errorMessage: 'unexpected pipeline crash',
      });
    });
  });

  // ─── markRunPermanentlyFailedAfterExhaustedRetries ───────────────────────────

  describe('markRunPermanentlyFailedAfterExhaustedRetries', () => {
    it('marks the run and Book failed (fenced) once BullMQ has exhausted every attempt', async () => {
      const run = makeGenerationRun({
        id: 'run-1',
        bookId: 'b-1',
        fencingVersion: 2,
        status: 'running' as GenerationRun['status'],
      });
      prisma.generationRun.findUnique.mockResolvedValue(run);
      prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });

      await service.markRunPermanentlyFailedAfterExhaustedRetries('run-1');

      expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
        where: { id: 'run-1', status: 'running', fencingVersion: 2 },
        data: {
          status: 'failed',
          failedAt: expect.any(Date),
          errorCode: 'GENERATION_INFRASTRUCTURE_FAILURE',
          errorMessage: expect.any(String),
        },
      });
      expect(prisma.book.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', activeRunId: 'run-1' },
        data: { activeRunId: null, status: 'failed', errorMessage: expect.any(String) },
      });
    });

    it('is a no-op when the run is already terminal (finished normally before retries were exhausted)', async () => {
      const run = makeGenerationRun({ status: 'completed' as GenerationRun['status'] });
      prisma.generationRun.findUnique.mockResolvedValue(run);

      await service.markRunPermanentlyFailedAfterExhaustedRetries('run-1');

      expect(prisma.generationRun.updateMany).not.toHaveBeenCalled();
      expect(prisma.book.updateMany).not.toHaveBeenCalled();
    });

    it('is a no-op when the run no longer exists', async () => {
      prisma.generationRun.findUnique.mockResolvedValue(null);

      await service.markRunPermanentlyFailedAfterExhaustedRetries('no-such-run');

      expect(prisma.generationRun.updateMany).not.toHaveBeenCalled();
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
