import { BookStatus, PageImageRevisionStatus, Prisma, type Book } from '@prisma/client';
import {
  Pronouns,
  type BookPreview,
  type CharacterCard,
  type ImageGenerationResult,
} from '@book/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderStorybookPdf } from '../pdf/pdf-renderer';
import { createMockPrisma } from '../common/test-utils/mock-prisma';
import { runWithCorrelation } from '../common/correlation/correlation-context';
import type { BookCrudService } from './book-crud.service';
import type { CreditsService } from '../credits/credits.service';
import type { ImageGenerationProvider } from '../images/image-generation-provider';
import type { ImageAssetStorage } from '../images/image-asset-storage';
import type { PdfStorage } from '../pdf/pdf-storage';
import { BookPageImageRevisionService } from './book-page-image-revision.service';

vi.mock('../pdf/pdf-renderer', () => ({ renderStorybookPdf: vi.fn() }));

const preview: BookPreview = {
  title: 'Adventure',
  subtitle: 'A story',
  cover: {
    title: 'Adventure',
    subtitle: 'A story',
    childName: 'Mia',
    illustrationPrompt: 'cover',
  },
  pages: [
    {
      pageNumber: 1,
      title: 'Page one',
      text: 'Text',
      illustrationPrompt: 'page',
      layout: 'image_top_text_bottom',
      learningGoal: 'Kindness',
      version: 2,
    },
  ],
  backCover: { message: 'End', educationalSummary: 'Kindness' },
  metadata: {
    language: 'en',
    theme: 'forest',
    childAge: 6,
    totalPages: 1,
    generatedBy: 'mock',
  },
};

const characterCard: CharacterCard = {
  name: 'Mia',
  age: 6,
  pronouns: Pronouns.TheyThem,
  appearance: {
    hairColor: 'brown',
    hairStyle: 'curly',
    eyeColor: 'brown',
    skinTone: 'warm',
    distinctiveFeatures: [],
  },
  personality: {
    traits: ['kind'],
    favoriteAnimals: [],
    favoriteColors: [],
    favoriteToys: [],
    hobbies: [],
  },
  visualAnchor: 'Mia in a yellow coat',
  narrativeDescription: 'A kind explorer',
};

const images: ImageGenerationResult = {
  provider: 'local_mock',
  status: 'complete',
  createdAt: '2026-07-26T00:00:00.000Z',
  images: [
    {
      id: 'cover',
      kind: 'cover',
      prompt: 'cover',
      provider: 'local_mock',
      status: 'complete',
      imageUrl: '/cover',
      altText: 'cover',
      width: 1024,
      height: 1024,
      seed: 'cover-seed',
    },
    {
      id: 'page-1',
      kind: 'page',
      pageNumber: 1,
      prompt: 'page',
      provider: 'local_mock',
      status: 'complete',
      imageUrl: '/page-1',
      altText: 'page',
      width: 1024,
      height: 1024,
      seed: 'page-seed',
    },
    {
      id: 'back',
      kind: 'back_cover',
      prompt: 'back',
      provider: 'local_mock',
      status: 'complete',
      imageUrl: '/back',
      altText: 'back',
      width: 1024,
      height: 1024,
      seed: 'back-seed',
    },
  ],
};

const sourceUpdatedAt = new Date('2026-07-26T12:00:00.000Z');

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'b-1',
    userId: 'u-1',
    status: BookStatus.complete,
    activeRunId: null,
    activePageImageRevisionId: null,
    publishedRunId: '11111111-1111-1111-1111-111111111111',
    publishedRunFencingVersion: 3,
    publishedPdfRunId: null,
    publishedPdfFencingVersion: null,
    updatedAt: sourceUpdatedAt,
    deletedAt: null,
    bookPreview: preview,
    imageGenerationResult: images,
    characterCard,
    characterSheetAssetKey: null,
    ...overrides,
  } as Book;
}

function makeRevision(status: PageImageRevisionStatus = PageImageRevisionStatus.quoted) {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    bookId: 'b-1',
    userId: 'u-1',
    pageNumber: 1,
    expectedPageVersion: 2,
    status,
    costCredits: 1,
    provider: 'mock',
    estimatedCostUsd: new Prisma.Decimal(0),
    quoteExpiresAt: new Date(Date.now() + 60_000),
    sourceBookUpdatedAt: sourceUpdatedAt,
    sourcePublishedRunId: '11111111-1111-1111-1111-111111111111',
    sourcePublishedRunFencingVersion: 3,
    sourcePublishedPdfRunId: null,
    sourcePublishedPdfFencingVersion: null,
    fencingVersion: status === PageImageRevisionStatus.running ? 1 : 0,
    deliveryToken: status === PageImageRevisionStatus.running ? 'token-1' : null,
    errorCode: null,
    errorMessage: null,
    confirmedAt: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createHarness(book = makeBook()) {
  const prisma = createMockPrisma();
  prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  prisma.bookPage.findUnique.mockResolvedValue({ version: 2 });
  prisma.bookPage.findMany.mockResolvedValue([]);
  prisma.book.updateMany.mockResolvedValue({ count: 1 });
  prisma.book.findUniqueOrThrow.mockResolvedValue({ updatedAt: sourceUpdatedAt });
  prisma.pageImageRevision.updateMany.mockResolvedValue({ count: 1 });
  const crud = {
    findOwnedOrThrow: vi.fn().mockResolvedValue(book),
  } as unknown as BookCrudService;
  const credits = {
    deductInTransaction: vi.fn().mockResolvedValue({}),
    addInTransaction: vi.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<CreditsService>;
  const provider = {
    providerName: 'mock',
    promptVersion: 'mock-v1',
    generateImage: vi.fn().mockResolvedValue({
      buffer: Buffer.from('new-image'),
      contentType: 'image/png',
    }),
  } as unknown as jest.Mocked<ImageGenerationProvider>;
  const imageStorage = {
    getImageAsset: vi.fn().mockResolvedValue(Buffer.from('old-image')),
    saveImageAsset: vi.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ImageAssetStorage>;
  const pdfStorage = {
    saveClaimPreviewPdf: vi.fn().mockResolvedValue({ url: '/new.pdf' }),
  } as unknown as jest.Mocked<PdfStorage>;
  const service = new BookPageImageRevisionService(
    crud,
    prisma as never,
    credits,
    provider,
    imageStorage,
    pdfStorage,
  );
  return { service, prisma, credits, provider, imageStorage, pdfStorage };
}

describe('BookPageImageRevisionService', () => {
  beforeEach(() => {
    vi.mocked(renderStorybookPdf).mockReset().mockResolvedValue(Buffer.from('%PDF'));
  });

  it('creates a server-owned quote without charging or calling the provider', async () => {
    const harness = createHarness();
    harness.prisma.pageImageRevision.create.mockResolvedValue(makeRevision());

    const quote = await harness.service.createQuote('u-1', 'b-1', 1, {
      expectedVersion: 2,
    });

    expect(quote).toMatchObject({
      costCredits: 1,
      expectedVersion: 2,
      confirmationRequired: true,
    });
    expect(harness.credits.deductInTransaction).not.toHaveBeenCalled();
    expect(harness.provider.generateImage).not.toHaveBeenCalled();
  });

  it('confirms once by reserving the book, charging, and creating an outbox event atomically', async () => {
    const harness = createHarness();
    const quoted = makeRevision();
    const queued = makeRevision(PageImageRevisionStatus.queued);
    harness.prisma.pageImageRevision.findFirst.mockResolvedValue(quoted);
    harness.prisma.book.findFirst.mockResolvedValue(makeBook());
    harness.prisma.pageImageRevision.findUniqueOrThrow.mockResolvedValue(queued);

    const requestId = '88888888-8888-4888-8888-888888888888';
    const result = await runWithCorrelation({ requestId }, () =>
      harness.service.confirm('u-1', 'b-1', 1, quoted.id),
    );

    expect(result.status).toBe('queued');
    expect(harness.prisma.book.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'b-1',
          deletedAt: null,
          activeRunId: null,
          activePageImageRevisionId: null,
        }),
      }),
    );
    expect(harness.credits.deductInTransaction).toHaveBeenCalledWith(
      harness.prisma,
      expect.objectContaining({
        amount: 1,
        reason: 'regen_page',
        idempotencyKey: `page-image-revision:${quoted.id}:charge`,
      }),
    );
    expect(harness.prisma.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateType: 'page_image_revision',
        aggregateId: quoted.id,
        payload: { bookId: 'b-1', revisionId: quoted.id, requestId },
      }),
    });
    expect(harness.provider.generateImage).not.toHaveBeenCalled();
  });

  it('generates only the selected image and atomically publishes its exact key plus a new PDF', async () => {
    const harness = createHarness(makeBook({ activePageImageRevisionId: makeRevision().id }));
    const running = makeRevision(PageImageRevisionStatus.running);
    harness.prisma.pageImageRevision.findUnique.mockResolvedValue({
      ...running,
      book: makeBook({ activePageImageRevisionId: running.id }),
    });

    await harness.service.executeClaimed(running.id, 1);

    expect(harness.provider.generateImage).toHaveBeenCalledOnce();
    expect(harness.imageStorage.saveImageAsset).toHaveBeenCalledWith(
      expect.stringContaining(`/runs/${running.id}/claims/1/page-1`),
      Buffer.from('new-image'),
      'image/png',
    );
    expect(harness.prisma.bookPage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          version: 3,
          imageRegenCount: { increment: 1 },
          imageR2Key: expect.stringContaining(`/runs/${running.id}/claims/1/page-1`),
        }),
      }),
    );
    expect(harness.prisma.book.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          activePageImageRevisionId: null,
          publishedPdfRunId: running.id,
          publishedPdfFencingVersion: 1,
        }),
      }),
    );
  });

  it('fails and refunds exactly from the original charge while preserving publication data', async () => {
    const harness = createHarness();
    const running = makeRevision(PageImageRevisionStatus.running);
    harness.prisma.pageImageRevision.findUnique.mockResolvedValue(running);
    harness.prisma.creditTransaction.findUnique.mockResolvedValue({
      userId: 'u-1',
      bookId: 'b-1',
      amount: -1,
    });

    await harness.service.failAndRefund(running.id);

    expect(harness.credits.addInTransaction).toHaveBeenCalledWith(harness.prisma, {
      userId: 'u-1',
      amount: 1,
      reason: 'refund_page_regeneration_failure',
      bookId: 'b-1',
      idempotencyKey: `page-image-revision:${running.id}:refund`,
    });
    expect(harness.prisma.book.updateMany).toHaveBeenCalledWith({
      where: { id: 'b-1', activePageImageRevisionId: running.id },
      data: { activePageImageRevisionId: null },
    });
  });
});
