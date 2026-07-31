import { ConflictException, HttpStatus } from '@nestjs/common';
import { Prisma, type Book, type GenerationRun } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockPrisma } from '../common/test-utils/mock-prisma';
import { runWithCorrelation } from '../common/correlation/correlation-context';
import type { CreditsService } from '../credits/credits.service';
import type { GenerationRunService } from '../agent/generation-run.service';
import type { GenerationInputSnapshotBackfillService } from '../agent/generation-input-snapshot-backfill.service';
import type { ImageGenerationProvider } from '../images/image-generation-provider';
import type { StoryGenerationProvider } from '../agent/story-generation-provider';
import type { CharacterProfileProvider } from '../agent/character-profile-provider';
import { GENERATION_HARD_BUDGET_EXCEEDED } from '../agent/generation-estimate';
import { hashInputSnapshot } from '../agent/generation-input-snapshot';
import type { BookCrudService } from './book-crud.service';
import {
  BookGenerationService,
  PAID_PROVIDER_CALL_BUDGET_INSUFFICIENT_CODE,
} from './book-generation.service';

const SNAPSHOT = {
  childName: 'Mia',
  childAge: 5,
  language: 'en',
  theme: 'friendship',
  educationalMessage: null,
  pageCount: 6,
  childPhoto: null,
};

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'book-1',
    userId: 'user-1',
    status: 'created',
    childName: 'Mia',
    childAge: 5,
    language: 'en',
    theme: 'friendship',
    educationalMessage: null,
    pageCount: 6,
    retryCount: 0,
    failedStep: null,
    errorMessage: null,
    childPhotoAssetKey: null,
    childPhotoContentType: null,
    childPhotoSha256: null,
    childPhotoSizeBytes: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
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
    inputSnapshot: SNAPSHOT,
    inputHash: 'hash',
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

describe('BookGenerationService scheduling boundary', () => {
  const prisma = createMockPrisma();
  const crud = { findOwnedOrThrow: vi.fn() } as unknown as jest.Mocked<BookCrudService>;
  const runs = {
    findActiveForBook: vi.fn(),
    findLatestForBook: vi.fn(),
    countActiveForUser: vi.fn(),
    countCreatedForUserSince: vi.fn(),
  } as unknown as jest.Mocked<GenerationRunService>;
  const snapshots = {
    normalize: vi.fn(),
  } as unknown as jest.Mocked<GenerationInputSnapshotBackfillService>;
  const credits = {
    deductInTransaction: vi.fn(),
  } as unknown as jest.Mocked<CreditsService>;
  const rateLimiter = {
    consume: vi.fn(),
  };
  const configValues: Record<string, number | string> = {
    GLOBAL_GENERATION_CIRCUIT_WINDOW_MS: 60_000,
    GLOBAL_GENERATION_CIRCUIT_MAX_PER_WINDOW: 100,
    MAX_CONCURRENT_GENERATIONS_PER_USER: 2,
    GENERATION_USER_WINDOW_MS: 86_400_000,
    MAX_GENERATIONS_PER_USER_PER_WINDOW: 20,
    MAX_GENERATED_IMAGES_PER_BOOK: 14,
    MAX_PAID_PROVIDER_CALLS_PER_RUN: 17,
    REAL_GENERATION_MAX_PROVIDER_CALLS_PER_RUN: 17,
    REAL_GENERATION_MAX_IMAGES_PER_RUN: 15,
    STORY_REPAIR_ENABLED: 'false',
    PRODUCT_MODE: 'demo',
  };
  const config = {
    get: vi.fn((key: string) => configValues[key]),
  };
  const imageProvider = { providerName: 'mock' } as ImageGenerationProvider;
  const storyProvider = { providerName: 'mock' } as StoryGenerationProvider;
  const characterProvider = { providerName: 'mock' } as CharacterProfileProvider;

  let service: BookGenerationService;

  beforeEach(() => {
    vi.clearAllMocks();
    config.get.mockImplementation((key: string) => configValues[key]);
    Object.assign(imageProvider, { providerName: 'mock' });
    Object.assign(storyProvider, { providerName: 'mock' });
    Object.assign(characterProvider, { providerName: 'mock' });
    crud.findOwnedOrThrow.mockResolvedValue(makeBook());
    runs.findActiveForBook.mockResolvedValue(null);
    runs.findLatestForBook.mockResolvedValue(null);
    runs.countActiveForUser.mockResolvedValue(0);
    runs.countCreatedForUserSince.mockResolvedValue(0);
    rateLimiter.consume.mockResolvedValue({ allowed: true, remaining: 99, retryAfterMs: 0 });
    prisma.generationRun.create.mockResolvedValue(makeRun());
    prisma.book.update.mockResolvedValue(makeBook({ status: 'char_build', activeRunId: 'run-1' }));
    prisma.outboxEvent.create.mockResolvedValue({} as never);
    prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => unknown) =>
      callback(prisma),
    );

    service = new BookGenerationService(
      crud,
      prisma as never,
      runs,
      snapshots,
      config as never,
      rateLimiter as never,
      credits,
      imageProvider,
      storyProvider,
      characterProvider,
    );
  });

  it('creates the run, charge, Book CAS, and outbox event in one transaction', async () => {
    await service.startGeneration('user-1', 'book-1');

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.generationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookId: 'book-1',
        userId: 'user-1',
        kind: 'initial',
        inputSnapshot: expect.objectContaining(SNAPSHOT),
      }),
    });
    expect(credits.deductInTransaction).toHaveBeenCalledWith(prisma, {
      userId: 'user-1',
      amount: 1,
      reason: 'book_creation',
      bookId: 'book-1',
      idempotencyKey: 'generation:run-1:charge',
    });
    expect(prisma.book.update).toHaveBeenCalledWith({
      where: {
        id: 'book-1',
        status: 'created',
        deletedAt: null,
        activePageImageRevisionId: null,
      },
      data: {
        status: 'char_build',
        activeRunId: 'run-1',
        failedStep: null,
        errorMessage: null,
      },
    });
    expect(prisma.outboxEvent.create).toHaveBeenCalledWith({
      data: {
        aggregateType: 'generation_run',
        aggregateId: 'run-1',
        eventType: 'run_queued',
        payload: { bookId: 'book-1', runId: 'run-1' },
      },
    });
  });

  it('schedules without a credit purchase or debit in home mode', async () => {
    config.get.mockImplementation((key: string) =>
      key === 'PRODUCT_MODE' ? 'home' : configValues[key],
    );

    await service.startGeneration('user-1', 'book-1');

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(credits.deductInTransaction).not.toHaveBeenCalled();
    expect(prisma.generationRun.create).toHaveBeenCalledOnce();
    expect(prisma.outboxEvent.create).toHaveBeenCalledOnce();
  });

  it('persists only the originating request ID as correlation metadata in the outbox payload', async () => {
    const requestId = '33333333-3333-4333-8333-333333333333';

    await runWithCorrelation({ requestId }, () => service.startGeneration('user-1', 'book-1'));

    expect(prisma.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: { bookId: 'book-1', runId: 'run-1', requestId },
      }),
    });
  });

  it('does not reach the transaction when admission rejects the user', async () => {
    rateLimiter.consume.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 1000 });

    await expect(service.startGeneration('user-1', 'book-1')).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      response: expect.objectContaining({ code: 'GENERATION_CAPACITY_EXCEEDED' }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(credits.deductInTransaction).not.toHaveBeenCalled();
  });

  it('budgets an enabled OpenAI repair before creating a run or charging credit', async () => {
    crud.findOwnedOrThrow.mockResolvedValue(makeBook({ pageCount: 12 }));
    Object.assign(imageProvider, { providerName: 'openai' });
    Object.assign(storyProvider, { providerName: 'openai' });
    Object.assign(characterProvider, { providerName: 'openai' });
    config.get.mockImplementation((key: string) => {
      if (key === 'STORY_REPAIR_ENABLED') return 'true';
      if (key === 'REAL_GENERATION_MAX_PROVIDER_CALLS_PER_RUN') return 18;
      return configValues[key];
    });

    await expect(service.startGeneration('user-1', 'book-1')).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      response: expect.objectContaining({
        code: PAID_PROVIDER_CALL_BUDGET_INSUFFICIENT_CODE,
      }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(credits.deductInTransaction).not.toHaveBeenCalled();
  });

  it('enforces the new hard provider-call limit before creating a run or charging', async () => {
    crud.findOwnedOrThrow.mockResolvedValue(makeBook({ pageCount: 4 }));
    Object.assign(imageProvider, { providerName: 'openai' });
    Object.assign(storyProvider, { providerName: 'openai' });
    Object.assign(characterProvider, { providerName: 'openai' });
    config.get.mockImplementation((key: string) =>
      key === 'REAL_GENERATION_MAX_PROVIDER_CALLS_PER_RUN' ? 8 : configValues[key],
    );

    await expect(service.startGeneration('user-1', 'book-1')).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      response: expect.objectContaining({ code: GENERATION_HARD_BUDGET_EXCEEDED }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(credits.deductInTransaction).not.toHaveBeenCalled();
  });

  it('maps the one-active-run database constraint to the stable conflict path', async () => {
    prisma.generationRun.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed.', {
        code: 'P2002',
        clientVersion: '5.17.0',
        meta: { modelName: 'GenerationRun', target: ['book_id'] },
      }),
    );

    await expect(service.startGeneration('user-1', 'book-1')).rejects.toThrow(ConflictException);
    expect(prisma.book.update).not.toHaveBeenCalled();
  });

  it('normalizes and links the prior immutable snapshot for a retry', async () => {
    const failed = makeBook({ status: 'failed', theme: 'edited-theme' });
    const prior = makeRun({ id: 'prior-run', inputSnapshot: SNAPSHOT });
    crud.findOwnedOrThrow.mockResolvedValue(failed);
    runs.findLatestForBook.mockResolvedValue(prior);
    snapshots.normalize.mockResolvedValue({ snapshot: SNAPSHOT, inputHash: 'normalized-hash' });

    await service.retryGeneration('user-1', 'book-1');

    expect(snapshots.normalize).toHaveBeenCalledWith(prior);
    expect(prisma.generationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'retry',
        retryOfRunId: 'prior-run',
        inputSnapshot: SNAPSHOT,
      }),
    });
  });

  it('excludes successful reusable provider work from a same-input retry estimate', async () => {
    Object.assign(imageProvider, { providerName: 'openai' });
    Object.assign(storyProvider, { providerName: 'openai' });
    Object.assign(characterProvider, { providerName: 'openai' });
    const failed = makeBook({
      status: 'failed',
      lastGenerationInputHash: hashInputSnapshot(SNAPSHOT),
      imageGenerationResult: {
        providerUsage: {
          calls: [
            { operation: 'story', provider: 'openai', status: 'success' },
            { operation: 'character_profile', provider: 'openai', status: 'success' },
            { operation: 'character_sheet', provider: 'openai', status: 'success' },
            { operation: 'illustration', provider: 'openai', status: 'success' },
          ],
        },
      },
    });
    const prior = makeRun({ id: 'prior-run', inputSnapshot: SNAPSHOT });
    crud.findOwnedOrThrow.mockResolvedValue(failed);
    runs.findLatestForBook.mockResolvedValue(prior);
    snapshots.normalize.mockResolvedValue({
      snapshot: SNAPSHOT,
      inputHash: hashInputSnapshot(SNAPSHOT),
    });

    await expect(service.estimateGeneration('user-1', 'book-1', 'retry')).resolves.toMatchObject({
      storyCalls: 0,
      characterProfileCalls: 0,
      imageCalls: 7,
      maximumProviderCalls: 7,
      reusedProviderCalls: 4,
    });
  });
});
