import { ConflictException } from '@nestjs/common';
import { BookStatus, type Book } from '@prisma/client';
import type { BookPreview, ImageGenerationResult } from '@book/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageAssetStorage } from '../images/image-asset-storage';
import { renderStorybookPdf } from '../pdf/pdf-renderer';
import type { PdfStorage } from '../pdf/pdf-storage';
import type { PrismaService } from '../database/prisma.service';
import type { BookCrudService } from './book-crud.service';
import { BookPageChangeService } from './book-page-change.service';

vi.mock('../pdf/pdf-renderer', () => ({
  renderStorybookPdf: vi.fn(),
}));

const preview: BookPreview = {
  title: 'A Small Adventure',
  subtitle: 'A story',
  cover: {
    title: 'A Small Adventure',
    subtitle: 'A story',
    childName: 'Mia',
    illustrationPrompt: 'cover',
  },
  pages: [
    {
      pageNumber: 1,
      title: 'Page one',
      text: 'Old text',
      illustrationPrompt: 'page one',
      layout: 'image_top_text_bottom',
      learningGoal: 'Kindness',
    },
  ],
  backCover: { message: 'The end', educationalSummary: 'Be kind' },
  metadata: {
    language: 'en',
    theme: 'forest',
    childAge: 6,
    totalPages: 1,
    generatedBy: 'mock',
  },
};

const imageResult: ImageGenerationResult = {
  provider: 'local_mock',
  status: 'complete',
  createdAt: '1970-01-01T00:00:00.000Z',
  images: [
    {
      id: 'b-1-cover',
      kind: 'cover',
      prompt: 'cover',
      provider: 'local_mock',
      status: 'complete',
      imageUrl: '/mock/cover',
      altText: 'cover',
      width: 1024,
      height: 1024,
      seed: '1',
    },
    {
      id: 'b-1-page-1',
      kind: 'page',
      pageNumber: 1,
      prompt: 'page',
      provider: 'local_mock',
      status: 'complete',
      imageUrl: '/mock/page-1',
      altText: 'page',
      width: 1024,
      height: 1024,
      seed: '2',
    },
    {
      id: 'b-1-back-cover',
      kind: 'back_cover',
      prompt: 'back',
      provider: 'local_mock',
      status: 'complete',
      imageUrl: '/mock/back-cover',
      altText: 'back',
      width: 1024,
      height: 1024,
      seed: '3',
    },
  ],
};

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'b-1',
    userId: 'u-1',
    status: BookStatus.complete,
    activeRunId: null,
    publishedRunId: '11111111-1111-1111-1111-111111111111',
    publishedRunFencingVersion: 4,
    publishedPdfRunId: null,
    publishedPdfFencingVersion: null,
    previewPdfUrl: '/old.pdf',
    bookPreview: preview,
    imageGenerationResult: imageResult,
    storyPlan: null,
    createdAt: new Date('2026-07-26T11:00:00.000Z'),
    updatedAt: new Date('2026-07-26T12:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  } as Book;
}

function createHarness(book = makeBook()) {
  const crud = {
    findOwnedOrThrow: vi.fn().mockResolvedValue(book),
  } as unknown as BookCrudService;
  const pageFindUnique = vi.fn();
  const bookUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const bookPageUpsert = vi.fn().mockResolvedValue({});
  const bookFindUniqueOrThrow = vi.fn().mockImplementation(async () => {
    const data = bookUpdateMany.mock.calls.at(-1)?.[0]?.data ?? {};
    return { ...book, ...data };
  });
  const tx = {
    book: { updateMany: bookUpdateMany, findUniqueOrThrow: bookFindUniqueOrThrow },
    bookPage: { findUnique: pageFindUnique, upsert: bookPageUpsert },
  };
  const prisma = {
    bookPage: { findUnique: pageFindUnique },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaService;
  const pdfStorage = {
    saveClaimPreviewPdf: vi.fn().mockResolvedValue({ url: '/new.pdf' }),
  } as unknown as PdfStorage;
  const imageStorage = {
    getImageAsset: vi.fn().mockResolvedValue(Buffer.from('image')),
  } as unknown as ImageAssetStorage;
  const service = new BookPageChangeService(crud, prisma, pdfStorage, imageStorage);
  return {
    service,
    prisma,
    pdfStorage,
    imageStorage,
    pageFindUnique,
    bookUpdateMany,
    bookPageUpsert,
  };
}

describe('BookPageChangeService', () => {
  beforeEach(() => {
    vi.mocked(renderStorybookPdf).mockReset().mockResolvedValue(Buffer.from('%PDF'));
  });

  it('publishes one text revision and a new PDF while retaining the published image namespace', async () => {
    const harness = createHarness();
    harness.pageFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const result = await harness.service.updatePageText('u-1', 'b-1', 1, {
      text: 'New text',
      expectedVersion: 1,
    });

    expect(harness.imageStorage.getImageAsset).toHaveBeenCalledWith(
      'books/b-1/runs/11111111-1111-1111-1111-111111111111/claims/4/page-1',
    );
    expect(harness.pdfStorage.saveClaimPreviewPdf).toHaveBeenCalledOnce();
    expect(harness.bookUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          publishedRunId: '11111111-1111-1111-1111-111111111111',
          publishedRunFencingVersion: 4,
          publishedPdfRunId: null,
          publishedPdfFencingVersion: null,
        }),
        data: expect.objectContaining({
          previewPdfUrl: '/new.pdf',
          publishedPdfFencingVersion: 1,
        }),
      }),
    );
    expect(harness.bookPageUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ textContent: 'New text', version: 2 }),
      }),
    );
    expect(result.bookPreview?.pages[0]).toMatchObject({ text: 'New text', version: 2 });
  });

  it('rejects a stale expectedVersion before rendering or storing a candidate', async () => {
    const harness = createHarness();
    harness.pageFindUnique.mockResolvedValueOnce({ version: 3 });

    await expect(
      harness.service.updatePageText('u-1', 'b-1', 1, {
        text: 'New text',
        expectedVersion: 1,
      }),
    ).rejects.toThrow(ConflictException);

    expect(renderStorybookPdf).not.toHaveBeenCalled();
    expect(harness.pdfStorage.saveClaimPreviewPdf).not.toHaveBeenCalled();
    expect(harness.bookUpdateMany).not.toHaveBeenCalled();
  });

  it('preserves the current publication when candidate PDF storage fails', async () => {
    const harness = createHarness();
    harness.pageFindUnique.mockResolvedValueOnce(null);
    vi.mocked(harness.pdfStorage.saveClaimPreviewPdf).mockRejectedValueOnce(
      new Error('storage unavailable'),
    );

    await expect(
      harness.service.updatePageText('u-1', 'b-1', 1, {
        text: 'New text',
        expectedVersion: 1,
      }),
    ).rejects.toThrow('storage unavailable');

    expect(harness.bookUpdateMany).not.toHaveBeenCalled();
    expect(harness.bookPageUpsert).not.toHaveBeenCalled();
  });

  it('rejects a concurrent Book change at the publication CAS boundary', async () => {
    const harness = createHarness();
    harness.pageFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    harness.bookUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      harness.service.updatePageText('u-1', 'b-1', 1, {
        text: 'New text',
        expectedVersion: 1,
      }),
    ).rejects.toThrow(ConflictException);

    expect(harness.pdfStorage.saveClaimPreviewPdf).toHaveBeenCalledOnce();
    expect(harness.bookPageUpsert).not.toHaveBeenCalled();
  });
});
