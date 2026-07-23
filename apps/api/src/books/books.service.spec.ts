import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  type Book,
  type CreditTransaction,
  type GenerationJob,
  type GenerationRun,
} from '@prisma/client';
import { BooksService } from './books.service';
import type { AgentService } from '../agent/agent.service';
import type { GenerationQueueService } from '../agent/generation-queue.service';
import type { GenerationJobService } from '../agent/generation-job.service';
import type { GenerationRunService } from '../agent/generation-run.service';
import { StaleGenerationRunError } from '../agent/generation-execution.service';
import { InvalidGenerationInputSnapshotError } from '../agent/generation-input-snapshot';
import {
  GenerationRunMirrorInvariantError,
  type GenerationRunCoordinator,
} from '../agent/generation-run-coordinator.service';
import type { GenerationInputSnapshotBackfillService } from '../agent/generation-input-snapshot-backfill.service';
import type { GenerationExecutionContext } from '../agent/generation-execution-context';
import type { GenerationOutcome } from '../agent/generation-outcome';
import type { PdfStorage } from '../pdf/pdf-storage';
import type { ImageAssetStorage } from '../images/image-asset-storage';
import type { ImageGenerationProvider } from '../images/image-generation-provider';
import { InvalidGenerationArtifactPointerError } from '../agent/generation-artifact-namespace';
import { GENERATION_INTERRUPTED_MESSAGE } from '../agent/generation-job-recovery.service';
import { createMockPrisma } from '../common/test-utils/mock-prisma';
import { INSUFFICIENT_CREDITS_CODE, type CreditsService } from '../credits/credits.service';
import type { CreateBookDto } from './dto/create-book.dto';
import type { UpdateBookDto } from './dto/update-book.dto';

type MockPrisma = ReturnType<typeof createMockPrisma>;

const EDITABLE_STATUSES = ['created', 'complete', 'failed', 'partial', 'cancelled'];

const VALID_SNAPSHOT = {
  childName: 'Mia',
  childAge: 5,
  language: 'en',
  theme: 'friendship',
  educationalMessage: null,
  pageCount: null,
  childPhoto: null,
};

function createMockAgentService(): jest.Mocked<AgentService> {
  return { startBookGeneration: vi.fn() } as unknown as jest.Mocked<AgentService>;
}

function createMockGenerationRunCoordinator(): jest.Mocked<GenerationRunCoordinator> {
  return {
    completeRun: vi.fn().mockResolvedValue('applied'),
    failAbandoned: vi.fn().mockResolvedValue('applied'),
    cancelGeneration: vi.fn(),
  } as unknown as jest.Mocked<GenerationRunCoordinator>;
}

/** Default: trusts the run's stored inputSnapshot is already current-shaped and echoes it back (paired with the run's own inputHash) — snapshot versioning/legacy-migration itself is covered by generation-input-snapshot-backfill.service.spec.ts. */
function createMockSnapshotBackfillService(): jest.Mocked<GenerationInputSnapshotBackfillService> {
  return {
    normalize: vi.fn(async (run: { inputSnapshot: unknown; inputHash: string }) => ({
      snapshot: run.inputSnapshot,
      inputHash: run.inputHash,
    })),
  } as unknown as jest.Mocked<GenerationInputSnapshotBackfillService>;
}

/** A minimal completed GenerationOutcome — the shape AgentService.startBookGeneration now returns instead of a Book. */
function makeOutcome(overrides: Partial<GenerationOutcome> = {}): GenerationOutcome {
  return {
    status: 'complete' as GenerationOutcome['status'],
    completedStep: 'pdf_render' as GenerationOutcome['completedStep'],
    bookUpdate: {},
    agentLogs: [],
    ...overrides,
  };
}

function createMockPdfStorage(): jest.Mocked<PdfStorage> {
  return {
    driver: 'local',
    savePreviewPdf: vi.fn(),
    getPreviewPdf: vi.fn(),
    previewPdfExists: vi.fn().mockResolvedValue(false),
    saveClaimPreviewPdf: vi.fn(),
    getClaimPreviewPdf: vi.fn(),
    claimPreviewPdfExists: vi.fn().mockResolvedValue(false),
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
    removeIfSafe: vi.fn().mockResolvedValue(undefined),
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
    markCancelled: vi
      .fn()
      .mockResolvedValue(makeGenerationJob({ status: 'cancelled' as GenerationJob['status'] })),
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
    inputSnapshot: VALID_SNAPSHOT,
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
    claim: vi
      .fn()
      .mockResolvedValue(makeGenerationRun({ status: 'running' as GenerationRun['status'] })),
  } as unknown as jest.Mocked<GenerationRunService>;
}

const GENERATION_GUARD_ENV = {
  GLOBAL_GENERATION_CIRCUIT_WINDOW_MS: 60_000,
  GLOBAL_GENERATION_CIRCUIT_MAX_PER_WINDOW: 100,
  MAX_CONCURRENT_GENERATIONS_PER_USER: 2,
  GENERATION_USER_WINDOW_MS: 86_400_000,
  MAX_GENERATIONS_PER_USER_PER_WINDOW: 20,
  MAX_GENERATED_IMAGES_PER_BOOK: 14,
} as const;

function createMockConfig(overrides: Partial<typeof GENERATION_GUARD_ENV> = {}) {
  const values: Record<string, number> = { ...GENERATION_GUARD_ENV, ...overrides };
  return { get: (key: string) => values[key] } as never;
}

function createMockRateLimiter(allowed = true) {
  return {
    consume: vi
      .fn()
      .mockResolvedValue({ allowed, remaining: allowed ? 99 : 0, retryAfterMs: 1000 }),
  } as never;
}

function createMockChildPhotoProcessor() {
  return {
    process: vi
      .fn()
      .mockResolvedValue({ buffer: Buffer.from('processed-bytes'), contentType: 'image/jpeg' }),
  } as never;
}

function createMockImageGenerationProvider(
  providerName: 'mock' | 'openai' = 'mock',
): jest.Mocked<ImageGenerationProvider> {
  return {
    providerName,
    generateImage: vi.fn(),
    generateCharacterSheet: vi.fn(),
  } as unknown as jest.Mocked<ImageGenerationProvider>;
}

function makeCreditTransaction(overrides: Partial<CreditTransaction> = {}): CreditTransaction {
  return {
    id: 'credit-tx-1',
    userId: 'u-1',
    bookId: 'b-1',
    amount: -1,
    balanceAfter: 2,
    reason: 'book_creation' as CreditTransaction['reason'],
    stripePaymentId: null,
    idempotencyKey: 'generation:run-1:charge',
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

/** Defaults to a successful charge — tests that need the stable 402 override deductInTransaction to reject. */
function createMockCreditsService(): jest.Mocked<CreditsService> {
  return {
    deductInTransaction: vi.fn().mockResolvedValue(makeCreditTransaction()),
    addInTransaction: vi.fn().mockResolvedValue(makeCreditTransaction({ amount: 1 })),
  } as unknown as jest.Mocked<CreditsService>;
}

/** Mirrors CreditsService.insufficientCreditsException's shape — the stable 402 the real service throws for a user with too few credits. */
function insufficientCreditsError(): HttpException {
  return new HttpException(
    {
      error: 'Insufficient credits',
      message: 'Insufficient credits',
      code: INSUFFICIENT_CREDITS_CODE,
    },
    HttpStatus.PAYMENT_REQUIRED,
  );
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
  let generationRunCoordinator: ReturnType<typeof createMockGenerationRunCoordinator>;
  let snapshotBackfill: ReturnType<typeof createMockSnapshotBackfillService>;
  let config: ReturnType<typeof createMockConfig>;
  let rateLimiter: ReturnType<typeof createMockRateLimiter>;
  let childPhotoProcessor: ReturnType<typeof createMockChildPhotoProcessor>;
  let creditsService: ReturnType<typeof createMockCreditsService>;
  let imageGenerationProvider: ReturnType<typeof createMockImageGenerationProvider>;

  function rebuildService(): void {
    service = new BooksService(
      prisma as never,
      agentService as never,
      pdfStorage as never,
      imageAssetStorage as never,
      generationQueueService as never,
      generationJobService as never,
      generationRunService as never,
      generationRunCoordinator as never,
      snapshotBackfill as never,
      config,
      rateLimiter,
      childPhotoProcessor,
      creditsService as never,
      imageGenerationProvider,
    );
  }

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
    generationRunCoordinator = createMockGenerationRunCoordinator();
    snapshotBackfill = createMockSnapshotBackfillService();
    config = createMockConfig();
    rateLimiter = createMockRateLimiter();
    childPhotoProcessor = createMockChildPhotoProcessor();
    creditsService = createMockCreditsService();
    imageGenerationProvider = createMockImageGenerationProvider();
    rebuildService();
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

    it('decodes/re-encodes the file via ChildPhotoProcessor before saving, mints a fresh versioned key, and persists the digest/size alongside the processor-reported content type', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      prisma.book.findFirst.mockResolvedValueOnce(book).mockResolvedValueOnce(book);
      prisma.book.updateMany.mockResolvedValue({ count: 1 });
      const rawFile = makeFile({ mimetype: 'image/png' }); // claimed type — must not be trusted
      const processedBuffer = Buffer.from('processed-bytes');
      const expectedSha256 = createHash('sha256').update(processedBuffer).digest('hex');
      childPhotoProcessor.process.mockResolvedValue({
        buffer: processedBuffer,
        contentType: 'image/jpeg',
      });

      const result = await service.uploadChildPhoto('u-1', 'b-1', rawFile);

      expect(childPhotoProcessor.process).toHaveBeenCalledWith(rawFile.buffer);
      const savedKey = imageAssetStorage.saveImageAsset.mock.calls[0]?.[0] as string;
      expect(savedKey).toMatch(/^b-1\/child-photo-[0-9a-f-]+$/);
      expect(imageAssetStorage.saveImageAsset).toHaveBeenCalledWith(
        savedKey,
        processedBuffer,
        'image/jpeg',
      );
      expect(prisma.book.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', userId: 'u-1', deletedAt: null, status: { in: EDITABLE_STATUSES } },
        data: {
          childPhotoAssetKey: savedKey,
          childPhotoContentType: 'image/jpeg',
          childPhotoSha256: expectedSha256,
          childPhotoSizeBytes: processedBuffer.length,
        },
      });
      expect(result.characterProfile).toBeNull();
    });

    it("mints a distinct key/digest on a second upload — re-uploading never mutates a prior version's bytes", async () => {
      const book = makeBook({ status: STATUS_CREATED });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.updateMany.mockResolvedValue({ count: 1 });
      childPhotoProcessor.process.mockResolvedValue({
        buffer: Buffer.from('bytes-v1'),
        contentType: 'image/jpeg',
      });

      await service.uploadChildPhoto('u-1', 'b-1', makeFile());
      const firstKey = imageAssetStorage.saveImageAsset.mock.calls[0]?.[0] as string;

      childPhotoProcessor.process.mockResolvedValue({
        buffer: Buffer.from('bytes-v2'),
        contentType: 'image/png',
      });
      await service.uploadChildPhoto('u-1', 'b-1', makeFile());
      const secondKey = imageAssetStorage.saveImageAsset.mock.calls[1]?.[0] as string;

      expect(firstKey).not.toBe(secondKey);
    });

    it('throws ConflictException (CAS) when generation started between the read and the write', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.uploadChildPhoto('u-1', 'b-1', makeFile())).rejects.toThrow(
        ConflictException,
      );
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
      expect(prisma.book.updateMany).not.toHaveBeenCalled();
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
      prisma.book.updateMany.mockResolvedValue({ count: 1 });

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
      prisma.book.findFirst.mockResolvedValueOnce(book).mockResolvedValueOnce(updated);
      prisma.book.updateMany.mockResolvedValue({ count: 1 });

      const dto: UpdateBookDto = { title: 'New Title' };
      const result = await service.update('b-1', 'u-1', dto);

      expect(prisma.book.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', userId: 'u-1', deletedAt: null, status: { in: EDITABLE_STATUSES } },
        data: dto,
      });
      expect(result.title).toBe('New Title');
    });

    it('throws ConflictException when the book is actively generating', async () => {
      const book = makeBook({ status: STATUS_IN_PROGRESS });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.update('b-1', 'u-1', { title: 'X' })).rejects.toThrow(ConflictException);
      expect(prisma.book.updateMany).not.toHaveBeenCalled();
    });

    it('throws ConflictException (CAS) when generation starts between the read and the write', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.update('b-1', 'u-1', { title: 'X' })).rejects.toThrow(ConflictException);
    });

    it('updates a complete book (edit-then-regenerate flow)', async () => {
      const book = makeBook({ status: STATUS_COMPLETE });
      const updated = makeBook({ title: 'New Title', status: STATUS_COMPLETE });
      prisma.book.findFirst.mockResolvedValueOnce(book).mockResolvedValueOnce(updated);
      prisma.book.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.update('b-1', 'u-1', { title: 'New Title' });

      expect(prisma.book.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', userId: 'u-1', deletedAt: null, status: { in: EDITABLE_STATUSES } },
        data: { title: 'New Title' },
      });
      expect(result.title).toBe('New Title');
    });

    it('updates a failed book', async () => {
      const book = makeBook({ status: STATUS_FAILED });
      const updated = makeBook({ title: 'New Title', status: STATUS_FAILED });
      prisma.book.findFirst.mockResolvedValueOnce(book).mockResolvedValueOnce(updated);
      prisma.book.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.update('b-1', 'u-1', { title: 'New Title' });

      expect(result.title).toBe('New Title');
    });
  });

  // ─── remove ───────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('soft-deletes by setting deletedAt when status is created', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.updateMany.mockResolvedValue({ count: 1 });

      await service.remove('b-1', 'u-1');

      expect(prisma.book.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', userId: 'u-1', deletedAt: null, status: { in: EDITABLE_STATUSES } },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('throws ConflictException when the book is actively generating', async () => {
      const book = makeBook({ status: STATUS_IN_PROGRESS });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.remove('b-1', 'u-1')).rejects.toThrow(ConflictException);
      expect(prisma.book.updateMany).not.toHaveBeenCalled();
    });

    it('throws ConflictException (CAS) when generation starts between the read and the write', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.remove('b-1', 'u-1')).rejects.toThrow(ConflictException);
    });

    it('soft-deletes a complete book', async () => {
      const book = makeBook({ status: STATUS_COMPLETE });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.updateMany.mockResolvedValue({ count: 1 });

      await service.remove('b-1', 'u-1');

      expect(prisma.book.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });

    it('soft-deletes a failed book', async () => {
      const book = makeBook({ status: STATUS_FAILED });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.updateMany.mockResolvedValue({ count: 1 });

      await service.remove('b-1', 'u-1');

      expect(prisma.book.updateMany).toHaveBeenCalled();
    });

    it('throws NotFoundException when book does not exist', async () => {
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.remove('no-such', 'u-1')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── startGeneration ─────────────────────────────────────────────────────────

  describe('startGeneration', () => {
    it('rejects an incomplete OpenAI image budget before creating a run or charging credit', async () => {
      const book = makeBook({ status: STATUS_CREATED, pageCount: 6 });
      prisma.book.findFirst.mockResolvedValue(book);
      config = createMockConfig({ MAX_GENERATED_IMAGES_PER_BOOK: 7 });
      imageGenerationProvider = createMockImageGenerationProvider('openai');
      rebuildService();

      await expect(service.startGeneration('u-1', 'b-1')).rejects.toMatchObject({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        response: expect.objectContaining({
          code: 'IMAGE_GENERATION_BUDGET_INSUFFICIENT',
        }),
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(creditsService.deductInTransaction).not.toHaveBeenCalled();
      expect(prisma.generationRun.create).not.toHaveBeenCalled();
      expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
    });

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

    it('charges exactly one credit for the newly created run, keyed on its own id, inside the same transaction', async () => {
      const book = makeBook({ status: STATUS_CREATED, userId: 'u-1' });
      const started = makeBook({ status: STATUS_CHAR_BUILD, activeRunId: 'run-1' });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(started);
      prisma.generationRun.create.mockResolvedValue(makeGenerationRun({ id: 'run-1' }));

      await service.startGeneration('u-1', 'b-1');

      expect(creditsService.deductInTransaction).toHaveBeenCalledOnce();
      expect(creditsService.deductInTransaction).toHaveBeenCalledWith(prisma, {
        userId: 'u-1',
        amount: 1,
        reason: 'book_creation',
        bookId: 'b-1',
        idempotencyKey: 'generation:run-1:charge',
      });
    });

    it('returns the stable 402 INSUFFICIENT_CREDITS error and rolls back the whole scheduling transaction when the user lacks balance', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      prisma.book.findFirst.mockResolvedValue(book);
      creditsService.deductInTransaction.mockRejectedValue(insufficientCreditsError());

      await expect(service.startGeneration('u-1', 'b-1')).rejects.toMatchObject({
        status: HttpStatus.PAYMENT_REQUIRED,
        response: expect.objectContaining({ code: INSUFFICIENT_CREDITS_CODE }),
      });
      expect(prisma.book.update).not.toHaveBeenCalled();
      expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
      expect(generationJobService.createQueued).not.toHaveBeenCalled();
    });

    it('logs the status transition from created to char_build', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const book = makeBook({ status: STATUS_CREATED });
      const started = makeBook({ status: STATUS_CHAR_BUILD, activeRunId: 'run-1' });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(started);

      await service.startGeneration('u-1', 'b-1');

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(`${STATUS_CREATED} -> char_build`),
      );
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

    it("charges exactly one credit for the retry's own new run — independent of any prior run's charge/refund", async () => {
      const book = makeBook({ status: STATUS_FAILED, userId: 'u-1' });
      const cleared = makeBook({ status: STATUS_CHAR_BUILD, activeRunId: 'retry-run-1' });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);
      prisma.generationRun.create.mockResolvedValue(makeGenerationRun({ id: 'retry-run-1' }));

      await service.retryGeneration('u-1', 'b-1');

      expect(creditsService.deductInTransaction).toHaveBeenCalledOnce();
      expect(creditsService.deductInTransaction).toHaveBeenCalledWith(prisma, {
        userId: 'u-1',
        amount: 1,
        reason: 'book_creation',
        bookId: 'b-1',
        idempotencyKey: 'generation:retry-run-1:charge',
      });
    });

    it('returns the stable 402 INSUFFICIENT_CREDITS error and never transitions Book when the user lacks balance', async () => {
      const book = makeBook({ status: STATUS_FAILED });
      prisma.book.findFirst.mockResolvedValue(book);
      creditsService.deductInTransaction.mockRejectedValue(insufficientCreditsError());

      await expect(service.retryGeneration('u-1', 'b-1')).rejects.toMatchObject({
        status: HttpStatus.PAYMENT_REQUIRED,
        response: expect.objectContaining({ code: INSUFFICIENT_CREDITS_CODE }),
      });
      expect(prisma.book.update).not.toHaveBeenCalled();
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

    it('Phase G1: throws ConflictException for a cancelled book — use regenerateBook instead, never retryGeneration', async () => {
      const book = makeBook({ status: 'cancelled' as Book['status'] });
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
      const priorSnapshot = {
        childName: 'Mia',
        childAge: 5,
        language: 'en',
        theme: 'original-theme',
        educationalMessage: null,
        pageCount: null,
        childPhoto: null,
      };
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
      const createCall = prisma.generationRun.create.mock.calls[0]?.[0] as {
        data: { retryOfRunId?: string };
      };
      expect(createCall.data.retryOfRunId).toBeUndefined();
    });

    it("throws a predictable ConflictException with the stable GENERATION_INPUT_SNAPSHOT_INVALID code when the prior run's stored snapshot is malformed, rather than an unhandled 500", async () => {
      const book = makeBook({ status: STATUS_FAILED });
      prisma.book.findFirst.mockResolvedValue(book);
      generationRunService.findLatestForBook.mockResolvedValue(
        makeGenerationRun({ id: 'prior-run-1', inputSnapshot: { this: 'is not valid' } }),
      );
      snapshotBackfill.normalize.mockRejectedValue(
        new InvalidGenerationInputSnapshotError('prior-run-1', new Error('malformed')),
      );

      await expect(service.retryGeneration('u-1', 'b-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'GENERATION_INPUT_SNAPSHOT_INVALID' }),
      });
      expect(prisma.generationRun.create).not.toHaveBeenCalled();
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

    it("charges exactly one credit for the regenerate's own new run", async () => {
      const book = makeBook({ status: STATUS_COMPLETE, userId: 'u-1' });
      const cleared = makeBook({ status: STATUS_CHAR_BUILD, activeRunId: 'regen-run-1' });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);
      prisma.generationRun.create.mockResolvedValue(makeGenerationRun({ id: 'regen-run-1' }));

      await service.regenerateBook('u-1', 'b-1');

      expect(creditsService.deductInTransaction).toHaveBeenCalledOnce();
      expect(creditsService.deductInTransaction).toHaveBeenCalledWith(prisma, {
        userId: 'u-1',
        amount: 1,
        reason: 'book_creation',
        bookId: 'b-1',
        idempotencyKey: 'generation:regen-run-1:charge',
      });
    });

    it('returns the stable 402 INSUFFICIENT_CREDITS error and never transitions Book when the user lacks balance', async () => {
      const book = makeBook({ status: STATUS_COMPLETE });
      prisma.book.findFirst.mockResolvedValue(book);
      creditsService.deductInTransaction.mockRejectedValue(insufficientCreditsError());

      await expect(service.regenerateBook('u-1', 'b-1')).rejects.toMatchObject({
        status: HttpStatus.PAYMENT_REQUIRED,
        response: expect.objectContaining({ code: INSUFFICIENT_CREDITS_CODE }),
      });
      expect(prisma.book.update).not.toHaveBeenCalled();
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

    it('Phase G1: regenerates a cancelled book, charging its new run independently of any earlier cancellation refund', async () => {
      const book = makeBook({ status: 'cancelled' as Book['status'] });
      const cleared = makeBook({ status: STATUS_CHAR_BUILD, activeRunId: 'regen-run-1' });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);
      prisma.generationRun.create.mockResolvedValue(makeGenerationRun({ id: 'regen-run-1' }));

      const result = await service.regenerateBook('u-1', 'b-1');

      expect(prisma.book.update).toHaveBeenCalledWith({
        where: { id: 'b-1', status: 'cancelled' },
        data: expect.objectContaining({ status: 'char_build', activeRunId: 'regen-run-1' }),
      });
      expect(creditsService.deductInTransaction).toHaveBeenCalledWith(prisma, {
        userId: 'u-1',
        amount: 1,
        reason: 'book_creation',
        bookId: 'b-1',
        idempotencyKey: 'generation:regen-run-1:charge',
      });
      expect(result.book.status).toBe('char_build');
    });

    it('never links retryOfRunId — a regenerate always starts a fresh lineage', async () => {
      const book = makeBook({ status: STATUS_COMPLETE });
      const cleared = makeBook({ status: STATUS_CHAR_BUILD, activeRunId: 'run-1' });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(cleared);
      generationRunService.findLatestForBook.mockResolvedValue(
        makeGenerationRun({ id: 'some-prior-run' }),
      );

      await service.regenerateBook('u-1', 'b-1');

      const createCall = prisma.generationRun.create.mock.calls[0]?.[0] as {
        data: { retryOfRunId?: string };
      };
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

  // ─── cancelGeneration (Phase G1) ───────────────────────────────────────────────

  describe('cancelGeneration', () => {
    it('maps "applied" to the CancelGenerationResponse shape and runs both best-effort follow-ups', async () => {
      const cancelledBook = makeBook({ status: 'cancelled' as Book['status'], activeRunId: null });
      generationRunCoordinator.cancelGeneration.mockResolvedValue({
        kind: 'applied',
        book: cancelledBook,
        creditsRefunded: 1,
        runId: 'run-1',
      });
      generationJobService.findActive.mockResolvedValue(makeGenerationJob());

      const result = await service.cancelGeneration('u-1', 'b-1');

      expect(generationRunCoordinator.cancelGeneration).toHaveBeenCalledWith({
        bookId: 'b-1',
        userId: 'u-1',
      });
      expect(result.creditsRefunded).toBe(1);
      expect(result.book.status).toBe('cancelled');
      expect(generationJobService.markCancelled).toHaveBeenCalledWith('job-1');
      expect(generationQueueService.removeIfSafe).toHaveBeenCalledWith('run-1');
    });

    it('returns creditsRefunded: 0 for a legacy/unbilled cancelled run', async () => {
      generationRunCoordinator.cancelGeneration.mockResolvedValue({
        kind: 'applied',
        book: makeBook({ status: 'cancelled' as Book['status'] }),
        creditsRefunded: 0,
        runId: 'run-1',
      });

      const result = await service.cancelGeneration('u-1', 'b-1');

      expect(result.creditsRefunded).toBe(0);
    });

    it('never touches the legacy GenerationJob mirror when none is active', async () => {
      generationRunCoordinator.cancelGeneration.mockResolvedValue({
        kind: 'applied',
        book: makeBook({ status: 'cancelled' as Book['status'] }),
        creditsRefunded: 0,
        runId: 'run-1',
      });
      generationJobService.findActive.mockResolvedValue(null);

      await service.cancelGeneration('u-1', 'b-1');

      expect(generationJobService.markCancelled).not.toHaveBeenCalled();
    });

    it('a legacy GenerationJob update failure never fails the request (best-effort, already logged/swallowed by markJob)', async () => {
      generationRunCoordinator.cancelGeneration.mockResolvedValue({
        kind: 'applied',
        book: makeBook({ status: 'cancelled' as Book['status'] }),
        creditsRefunded: 0,
        runId: 'run-1',
      });
      generationJobService.findActive.mockResolvedValue(makeGenerationJob());
      generationJobService.markCancelled.mockRejectedValue(new Error('db blip'));

      await expect(service.cancelGeneration('u-1', 'b-1')).resolves.toBeDefined();
    });

    it('throws NotFoundException for "not_found"', async () => {
      generationRunCoordinator.cancelGeneration.mockResolvedValue({ kind: 'not_found' });

      await expect(service.cancelGeneration('u-1', 'missing')).rejects.toThrow(NotFoundException);
      expect(generationQueueService.removeIfSafe).not.toHaveBeenCalled();
    });

    it('throws a stable 409 BOOK_ALREADY_CANCELLED for "already_cancelled"', async () => {
      generationRunCoordinator.cancelGeneration.mockResolvedValue({ kind: 'already_cancelled' });

      await expect(service.cancelGeneration('u-1', 'b-1')).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
        response: expect.objectContaining({ code: 'BOOK_ALREADY_CANCELLED' }),
      });
    });

    it('throws a stable 409 BOOK_NOT_IN_PROGRESS for "not_in_progress"', async () => {
      generationRunCoordinator.cancelGeneration.mockResolvedValue({ kind: 'not_in_progress' });

      await expect(service.cancelGeneration('u-1', 'b-1')).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
        response: expect.objectContaining({ code: 'BOOK_NOT_IN_PROGRESS' }),
      });
    });

    it('rethrows GenerationRunMirrorInvariantError for "book_mirror_mismatch" rather than a stable 4xx', async () => {
      generationRunCoordinator.cancelGeneration.mockResolvedValue({
        kind: 'book_mirror_mismatch',
        runId: 'run-1',
        bookId: 'b-1',
      });

      await expect(service.cancelGeneration('u-1', 'b-1')).rejects.toThrow(
        GenerationRunMirrorInvariantError,
      );
      expect(generationQueueService.removeIfSafe).not.toHaveBeenCalled();
    });
  });

  // ─── runGenerationPipeline ────────────────────────────────────────────────────

  describe('runGenerationPipeline', () => {
    function makeCtx(
      overrides: Partial<GenerationExecutionContext> = {},
    ): GenerationExecutionContext {
      return {
        runId: 'run-1',
        bookId: 'b-1',
        fencingVersion: 0,
        inputHash: 'run-input-hash',
        inputSnapshot: VALID_SNAPSHOT,
        ...overrides,
      };
    }

    it('calls AgentService.startBookGeneration with the execution context built from the claimed run', async () => {
      const ctx = makeCtx();
      agentService.startBookGeneration.mockResolvedValue(makeOutcome());

      await service.runGenerationPipeline(ctx);

      expect(agentService.startBookGeneration).toHaveBeenCalledOnce();
      expect(agentService.startBookGeneration).toHaveBeenCalledWith(ctx);
    });

    it('on success: publishes the outcome via GenerationRunCoordinator.completeRun — the sole place Book.status is ever written', async () => {
      const ctx = makeCtx({ runId: 'run-1', bookId: 'b-1', fencingVersion: 3 });
      const outcome = makeOutcome();
      agentService.startBookGeneration.mockResolvedValue(outcome);

      await service.runGenerationPipeline(ctx);

      expect(generationRunCoordinator.completeRun).toHaveBeenCalledWith(ctx, outcome);
    });

    it('on success: marks the legacy GenerationJob completed when one exists', async () => {
      const ctx = makeCtx();
      agentService.startBookGeneration.mockResolvedValue(makeOutcome());
      generationJobService.findActive.mockResolvedValue(makeGenerationJob());

      await service.runGenerationPipeline(ctx);

      expect(generationJobService.markRunning).toHaveBeenCalledWith('job-1');
      expect(generationJobService.markCompleted).toHaveBeenCalledWith('job-1');
      expect(generationJobService.markFailed).not.toHaveBeenCalled();
    });

    it('logs the pipeline outcome (e.g. -> complete)', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const ctx = makeCtx();
      agentService.startBookGeneration.mockResolvedValue(makeOutcome());

      await service.runGenerationPipeline(ctx);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('pipeline outcome -> complete'));
      logSpy.mockRestore();
    });

    it('on an expected content failure (AgentService returns a failed outcome): publishes it via the coordinator, without writing Book itself', async () => {
      const ctx = makeCtx({ runId: 'run-1', bookId: 'b-1', fencingVersion: 0 });
      const outcome = makeOutcome({
        status: STATUS_FAILED as GenerationOutcome['status'],
        errorCode: 'GENERATION_FAILED',
        errorMessage: 'OpenAI image request failed',
        failedStep: 'image_gen' as GenerationOutcome['failedStep'],
      });
      agentService.startBookGeneration.mockResolvedValue(outcome);

      await service.runGenerationPipeline(ctx);

      expect(generationRunCoordinator.completeRun).toHaveBeenCalledWith(ctx, outcome);
      expect(prisma.book.updateMany).not.toHaveBeenCalled();
      expect(prisma.generationRun.updateMany).not.toHaveBeenCalled();
    });

    it('on an expected content failure: marks the legacy GenerationJob failed (with failedStep/errorMessage) when one exists', async () => {
      const ctx = makeCtx();
      agentService.startBookGeneration.mockResolvedValue(
        makeOutcome({
          status: STATUS_FAILED as GenerationOutcome['status'],
          errorMessage: 'OpenAI image request failed',
          failedStep: 'image_gen' as GenerationOutcome['failedStep'],
        }),
      );
      generationJobService.findActive.mockResolvedValue(makeGenerationJob());

      await service.runGenerationPipeline(ctx);

      expect(generationJobService.markFailed).toHaveBeenCalledWith('job-1', {
        errorMessage: 'OpenAI image request failed',
        failedStep: 'image_gen',
      });
      expect(generationJobService.markCompleted).not.toHaveBeenCalled();
    });

    it('swallows StaleGenerationRunError from AgentService without calling the coordinator — a newer attempt already owns this run', async () => {
      const ctx = makeCtx();
      agentService.startBookGeneration.mockRejectedValue(
        new StaleGenerationRunError('run-1', 'layout' as never),
      );

      await expect(service.runGenerationPipeline(ctx)).resolves.toBeUndefined();

      expect(generationRunCoordinator.completeRun).not.toHaveBeenCalled();
    });

    it('on an unexpected/transient error: does not call the coordinator, and rethrows so BullMQ retries', async () => {
      const ctx = makeCtx();
      agentService.startBookGeneration.mockRejectedValue(new Error('unexpected pipeline crash'));

      await expect(service.runGenerationPipeline(ctx)).rejects.toThrow('unexpected pipeline crash');

      expect(generationRunCoordinator.completeRun).not.toHaveBeenCalled();
    });

    it('on an unexpected/transient error: marks the legacy GenerationJob failed (best-effort) but still rethrows', async () => {
      const ctx = makeCtx();
      agentService.startBookGeneration.mockRejectedValue(new Error('unexpected pipeline crash'));
      generationJobService.findActive.mockResolvedValue(makeGenerationJob());

      await expect(service.runGenerationPipeline(ctx)).rejects.toThrow();

      expect(generationJobService.markFailed).toHaveBeenCalledWith('job-1', {
        errorMessage: 'unexpected pipeline crash',
      });
    });

    it('does NOT mark the legacy GenerationJob completed/failed when completeRun reports the run was superseded (stale_fence) — a superseded worker must not touch diagnostics for whichever attempt actually owns the run now', async () => {
      const ctx = makeCtx();
      agentService.startBookGeneration.mockResolvedValue(makeOutcome());
      generationJobService.findActive.mockResolvedValue(makeGenerationJob());
      generationRunCoordinator.completeRun.mockResolvedValue('stale_fence');

      await service.runGenerationPipeline(ctx);

      expect(generationJobService.markCompleted).not.toHaveBeenCalled();
      expect(generationJobService.markFailed).not.toHaveBeenCalled();
    });

    it('throws GenerationRunMirrorInvariantError (never a silent success) when completeRun reports a book_mirror_mismatch, and does NOT mark the legacy GenerationJob completed/failed', async () => {
      const ctx = makeCtx();
      agentService.startBookGeneration.mockResolvedValue(
        makeOutcome({ status: STATUS_FAILED as GenerationOutcome['status'] }),
      );
      generationJobService.findActive.mockResolvedValue(makeGenerationJob());
      generationRunCoordinator.completeRun.mockResolvedValue('book_mirror_mismatch');

      await expect(service.runGenerationPipeline(ctx)).rejects.toBeInstanceOf(
        GenerationRunMirrorInvariantError,
      );

      expect(generationJobService.markCompleted).not.toHaveBeenCalled();
      expect(generationJobService.markFailed).not.toHaveBeenCalled();
    });
  });

  // ─── markRunPermanentlyFailedAfterExhaustedRetries ───────────────────────────

  describe('markRunPermanentlyFailedAfterExhaustedRetries', () => {
    it('finalizes the run via GenerationRunCoordinator.failAbandoned (fenced on the run row it read) once BullMQ has exhausted every attempt', async () => {
      const run = makeGenerationRun({
        id: 'run-1',
        bookId: 'b-1',
        fencingVersion: 2,
        status: 'running' as GenerationRun['status'],
      });
      prisma.generationRun.findUnique.mockResolvedValue(run);

      await service.markRunPermanentlyFailedAfterExhaustedRetries('run-1');

      expect(generationRunCoordinator.failAbandoned).toHaveBeenCalledWith(
        { runId: 'run-1', bookId: 'b-1', fencingVersion: 2, fromStatus: 'running' },
        { errorCode: 'GENERATION_INFRASTRUCTURE_FAILURE', errorMessage: expect.any(String) },
      );
    });

    it('is a no-op when the run is already terminal (finished normally before retries were exhausted)', async () => {
      const run = makeGenerationRun({ status: 'completed' as GenerationRun['status'] });
      prisma.generationRun.findUnique.mockResolvedValue(run);

      await service.markRunPermanentlyFailedAfterExhaustedRetries('run-1');

      expect(generationRunCoordinator.failAbandoned).not.toHaveBeenCalled();
    });

    it('is a no-op when the run no longer exists', async () => {
      prisma.generationRun.findUnique.mockResolvedValue(null);

      await service.markRunPermanentlyFailedAfterExhaustedRetries('no-such-run');

      expect(generationRunCoordinator.failAbandoned).not.toHaveBeenCalled();
    });

    it('does not mark the legacy GenerationJob when the coordinator reports the run was already superseded', async () => {
      const run = makeGenerationRun({
        id: 'run-1',
        bookId: 'b-1',
        fencingVersion: 2,
        status: 'running' as GenerationRun['status'],
      });
      prisma.generationRun.findUnique.mockResolvedValue(run);
      generationRunCoordinator.failAbandoned.mockResolvedValue('stale_fence');
      generationJobService.findActive.mockResolvedValue(makeGenerationJob());

      await service.markRunPermanentlyFailedAfterExhaustedRetries('run-1');

      expect(generationJobService.markFailed).not.toHaveBeenCalled();
    });

    it('throws GenerationRunMirrorInvariantError (never a silent no-op) when the coordinator reports a book_mirror_mismatch', async () => {
      const run = makeGenerationRun({
        id: 'run-1',
        bookId: 'b-1',
        fencingVersion: 2,
        status: 'running' as GenerationRun['status'],
      });
      prisma.generationRun.findUnique.mockResolvedValue(run);
      generationRunCoordinator.failAbandoned.mockResolvedValue('book_mirror_mismatch');
      generationJobService.findActive.mockResolvedValue(makeGenerationJob());

      await expect(
        service.markRunPermanentlyFailedAfterExhaustedRetries('run-1'),
      ).rejects.toBeInstanceOf(GenerationRunMirrorInvariantError);

      expect(generationJobService.markFailed).not.toHaveBeenCalled();
    });

    it('marks the legacy GenerationJob failed once the coordinator confirms the transition applied', async () => {
      const run = makeGenerationRun({
        id: 'run-1',
        bookId: 'b-1',
        fencingVersion: 2,
        status: 'running' as GenerationRun['status'],
      });
      prisma.generationRun.findUnique.mockResolvedValue(run);
      generationJobService.findActive.mockResolvedValue(makeGenerationJob());

      await service.markRunPermanentlyFailedAfterExhaustedRetries('run-1');

      expect(generationJobService.markFailed).toHaveBeenCalledWith('job-1', {
        errorMessage: expect.any(String),
      });
    });
  });

  // ─── getPreviewPdfBuffer ──────────────────────────────────────────────────────

  describe('getPreviewPdfBuffer', () => {
    const PDF_RESULT = {
      buffer: Buffer.from('%PDF-1.4 test'),
      contentType: 'application/pdf' as const,
      filename: 'storyme-preview-b-1.pdf',
    };

    it('returns PDF buffer for a complete book with previewPdfUrl and existing file (pre-GenerationRun legacy publication)', async () => {
      const book = makeBook({ previewPdfUrl: '/files/books/b-1/storybook.pdf' });
      prisma.book.findFirst.mockResolvedValue(book);
      pdfStorage.getPreviewPdf.mockResolvedValue(PDF_RESULT);

      const result = await service.getPreviewPdfBuffer('b-1', 'u-1');

      expect(pdfStorage.getPreviewPdf).toHaveBeenCalledWith('b-1');
      expect(pdfStorage.getClaimPreviewPdf).not.toHaveBeenCalled();
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

    it('throws ConflictException when previewPdfUrl is null and no published pointer exists (not ready)', async () => {
      const book = makeBook({ previewPdfUrl: null });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.getPreviewPdfBuffer('b-1', 'u-1')).rejects.toThrow(ConflictException);
      expect(pdfStorage.getPreviewPdf).not.toHaveBeenCalled();
      expect(pdfStorage.getClaimPreviewPdf).not.toHaveBeenCalled();
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

    it('reads the exact published claim namespace when publishedRunId/publishedRunFencingVersion are both set', async () => {
      const book = makeBook({
        previewPdfUrl: '/files/books/b-1/runs/run-9/claims/2/storyme-preview-b-1.pdf',
        publishedRunId: 'run-9',
        publishedRunFencingVersion: 2,
      });
      prisma.book.findFirst.mockResolvedValue(book);
      pdfStorage.getClaimPreviewPdf.mockResolvedValue(PDF_RESULT);

      const result = await service.getPreviewPdfBuffer('b-1', 'u-1');

      expect(pdfStorage.getClaimPreviewPdf).toHaveBeenCalledWith('b-1', {
        kind: 'claim',
        runId: 'run-9',
        fencingVersion: 2,
      });
      expect(pdfStorage.getPreviewPdf).not.toHaveBeenCalled();
      expect(result.contentType).toBe('application/pdf');
      expect(result.filename).toBe('storyme-preview-b-1.pdf');
    });

    it('never falls back to the legacy PDF when a complete claim pointer is present but its object is missing', async () => {
      const book = makeBook({
        previewPdfUrl: '/files/books/b-1/runs/run-9/claims/2/storyme-preview-b-1.pdf',
        publishedRunId: 'run-9',
        publishedRunFencingVersion: 2,
      });
      prisma.book.findFirst.mockResolvedValue(book);
      pdfStorage.getClaimPreviewPdf.mockResolvedValue(null);
      pdfStorage.getPreviewPdf.mockResolvedValue(PDF_RESULT); // would be wrong bytes to serve

      await expect(service.getPreviewPdfBuffer('b-1', 'u-1')).rejects.toThrow(NotFoundException);
      expect(pdfStorage.getPreviewPdf).not.toHaveBeenCalled();
    });

    it('reads the legacy PDF for a pre-Phase-B publication (publishedRunId set, publishedRunFencingVersion null)', async () => {
      const book = makeBook({
        previewPdfUrl: '/files/books/b-1/storybook.pdf',
        publishedRunId: 'run-legacy',
        publishedRunFencingVersion: null,
      });
      prisma.book.findFirst.mockResolvedValue(book);
      pdfStorage.getPreviewPdf.mockResolvedValue(PDF_RESULT);

      const result = await service.getPreviewPdfBuffer('b-1', 'u-1');

      expect(pdfStorage.getPreviewPdf).toHaveBeenCalledWith('b-1');
      expect(pdfStorage.getClaimPreviewPdf).not.toHaveBeenCalled();
      expect(result.buffer).toBe(PDF_RESULT.buffer);
    });

    it('throws the stable invariant error for an invalid partial published pointer (publishedRunId null, fencingVersion set)', async () => {
      const book = makeBook({
        previewPdfUrl: null,
        publishedRunId: null,
        publishedRunFencingVersion: 4,
      });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.getPreviewPdfBuffer('b-1', 'u-1')).rejects.toThrow(
        InvalidGenerationArtifactPointerError,
      );
    });

    it('preserves the download filename and content type regardless of which namespace served the bytes', async () => {
      const book = makeBook({
        previewPdfUrl: '/files/books/b-1/runs/run-9/claims/2/storyme-preview-b-1.pdf',
        publishedRunId: 'run-9',
        publishedRunFencingVersion: 2,
      });
      prisma.book.findFirst.mockResolvedValue(book);
      pdfStorage.getClaimPreviewPdf.mockResolvedValue(PDF_RESULT);

      const result = await service.getPreviewPdfBuffer('b-1', 'u-1');

      expect(result.filename).toBe('storyme-preview-b-1.pdf');
      expect(result.contentType).toBe('application/pdf');
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

    it('reports pdfStorage.previewAvailable=true when previewPdfUrl is set and the storage backend confirms the object exists (legacy publication)', async () => {
      const book = makeBook({
        status: STATUS_COMPLETE,
        previewPdfUrl: '/files/books/b-1/storybook.pdf',
      });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.agentLog.findMany.mockResolvedValue([]);
      pdfStorage.previewPdfExists.mockResolvedValue(true);

      const result = await service.getGenerationDiagnostics('b-1', 'u-1');

      expect(pdfStorage.previewPdfExists).toHaveBeenCalledWith('b-1');
      expect(pdfStorage.claimPreviewPdfExists).not.toHaveBeenCalled();
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

    it('checks the exact published claim namespace (not the legacy key) when publishedRunId/publishedRunFencingVersion are both set', async () => {
      const book = makeBook({
        status: STATUS_COMPLETE,
        previewPdfUrl: '/files/books/b-1/runs/run-9/claims/2/storyme-preview-b-1.pdf',
        publishedRunId: 'run-9',
        publishedRunFencingVersion: 2,
      });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.agentLog.findMany.mockResolvedValue([]);
      pdfStorage.claimPreviewPdfExists.mockResolvedValue(true);

      const result = await service.getGenerationDiagnostics('b-1', 'u-1');

      expect(pdfStorage.claimPreviewPdfExists).toHaveBeenCalledWith('b-1', {
        kind: 'claim',
        runId: 'run-9',
        fencingVersion: 2,
      });
      expect(pdfStorage.previewPdfExists).not.toHaveBeenCalled();
      expect(result.pdfStorage).toEqual({
        driver: 'local',
        keyPresent: true,
        previewAvailable: true,
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
