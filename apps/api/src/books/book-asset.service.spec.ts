import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { Book } from '@prisma/client';
import sharp from 'sharp';
import type { ImageAssetStorage } from '../images/image-asset-storage';
import { COVER_THUMBNAIL_MAX_HEIGHT, COVER_THUMBNAIL_MAX_WIDTH } from '../images/cover-thumbnail';
import type { PdfStorage } from '../pdf/pdf-storage';
import type { ChildPhotoProcessor } from '../images/child-photo-processor';
import type { PrismaService } from '../database/prisma.service';
import { BookAssetService, parsePublishedImageId } from './book-asset.service';
import type { BookCrudService } from './book-crud.service';
import { createFakeArtifactWrites } from '../common/test-utils/fake-artifact-writes';
import { BookArtifactWritesClosedError } from '../storage/book-artifact-write-coordinator';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'b-1',
    userId: 'u-1',
    publishedRunId: 'run-9',
    publishedRunFencingVersion: 2,
    previewPdfUrl: '/published.pdf',
    deletedAt: null,
    ...overrides,
  } as Book;
}

function createHarness(book: Book | null = makeBook()) {
  const crud = {
    findOwnedOrThrow: vi.fn().mockImplementation(async () => {
      if (!book) throw new NotFoundException('Book not found');
      return book;
    }),
  } as unknown as jest.Mocked<BookCrudService>;
  const imageStorage = {
    getImageAsset: vi.fn(),
    saveImageAsset: vi.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ImageAssetStorage>;
  const prisma = {
    bookPage: { findUnique: vi.fn().mockResolvedValue(null) },
  } as unknown as PrismaService;
  const artifactWrites = createFakeArtifactWrites();
  const service = new BookAssetService(
    crud,
    prisma,
    {} as PdfStorage,
    imageStorage,
    {} as ChildPhotoProcessor,
    artifactWrites as never,
  );
  return { service, crud, imageStorage, prisma, artifactWrites };
}

describe('parsePublishedImageId', () => {
  it.each([
    ['cover', { id: 'cover', kind: 'cover' }],
    ['cover-thumb', { id: 'cover-thumb', kind: 'cover', thumbnail: true }],
    ['back-cover', { id: 'back-cover', kind: 'back_cover' }],
    ['page-1', { id: 'page-1', kind: 'page', pageNumber: 1 }],
    ['page-12', { id: 'page-12', kind: 'page', pageNumber: 12 }],
  ])('accepts %s', (value, expected) => {
    expect(parsePublishedImageId(value)).toEqual(expected);
  });

  it.each(['character-sheet', 'page-0', 'page-13', 'page-01', '../cover'])(
    'rejects unsupported identifier %s without treating it as a storage key',
    (value) => {
      expect(() => parsePublishedImageId(value)).toThrow(BadRequestException);
    },
  );
});

describe('BookAssetService.getPublishedImage', () => {
  it('reads the exact published claim namespace and detects PNG content', async () => {
    const { service, imageStorage } = createHarness(
      makeBook({
        lastGenerationRunId: 'newer-failed-run',
        lastGenerationFencingVersion: 7,
        activeRunId: null,
      }),
    );
    imageStorage.getImageAsset.mockResolvedValue(PNG_BYTES);

    const result = await service.getPublishedImage('b-1', 'u-1', 'cover');

    expect(imageStorage.getImageAsset).toHaveBeenCalledWith('books/b-1/runs/run-9/claims/2/cover');
    expect(result).toEqual({
      buffer: PNG_BYTES,
      contentType: 'image/png',
      filename: 'cover.png',
    });
  });

  it('prefers a page-level immutable image key while leaving the book namespace unchanged', async () => {
    const { service, imageStorage, prisma } = createHarness();
    const pageKey = 'books/b-1/runs/22222222-2222-2222-2222-222222222222/claims/1/page-2';
    vi.mocked(prisma.bookPage.findUnique).mockResolvedValue({ imageR2Key: pageKey } as never);
    imageStorage.getImageAsset.mockResolvedValue(PNG_BYTES);

    await service.getPublishedImage('b-1', 'u-1', 'page-2');

    expect(imageStorage.getImageAsset).toHaveBeenCalledWith(pageKey);
  });

  it('uses the legacy published namespace for pre-claim books', async () => {
    const { service, imageStorage } = createHarness(
      makeBook({ publishedRunId: null, publishedRunFencingVersion: null }),
    );
    imageStorage.getImageAsset.mockResolvedValue(SVG_BYTES);

    const result = await service.getPublishedImage('b-1', 'u-1', 'back-cover');

    expect(imageStorage.getImageAsset).toHaveBeenCalledWith('b-1/back-cover');
    expect(result.contentType).toBe('image/svg+xml');
    expect(result.filename).toBe('back-cover.svg');
  });

  it('returns the same 404 for a missing or differently-owned book before reading storage', async () => {
    const { service, imageStorage } = createHarness(null);

    await expect(service.getPublishedImage('b-1', 'u-other', 'cover')).rejects.toThrow(
      NotFoundException,
    );
    expect(imageStorage.getImageAsset).not.toHaveBeenCalled();
  });

  it('rejects a book with no successful publication', async () => {
    const { service, imageStorage } = createHarness(
      makeBook({
        publishedRunId: null,
        publishedRunFencingVersion: null,
        previewPdfUrl: null,
      }),
    );

    await expect(service.getPublishedImage('b-1', 'u-1', 'page-1')).rejects.toThrow(
      ConflictException,
    );
    expect(imageStorage.getImageAsset).not.toHaveBeenCalled();
  });

  it('does not fall back when the exact published image is missing', async () => {
    const { service, imageStorage } = createHarness();
    imageStorage.getImageAsset.mockResolvedValue(undefined);

    await expect(service.getPublishedImage('b-1', 'u-1', 'page-2')).rejects.toThrow(
      NotFoundException,
    );
    expect(imageStorage.getImageAsset).toHaveBeenCalledTimes(1);
  });

  it('fails safely when stored bytes are not a supported image format', async () => {
    const { service, imageStorage } = createHarness();
    imageStorage.getImageAsset.mockResolvedValue(Buffer.from('not an image'));

    await expect(service.getPublishedImage('b-1', 'u-1', 'cover')).rejects.toThrow(
      InternalServerErrorException,
    );
  });
});

describe('BookAssetService.getPublishedImage cover-thumb', () => {
  const COVER_KEY = 'books/b-1/runs/run-9/claims/2/cover';
  const THUMB_KEY = `${COVER_KEY}-thumb`;

  function largeCover(): Promise<Buffer> {
    return sharp({
      create: { width: 2400, height: 3200, channels: 3, background: { r: 120, g: 80, b: 200 } },
    })
      .png()
      .toBuffer();
  }

  it('builds a bounded WebP derivative from the immutable cover and caches it beside it', async () => {
    const { service, imageStorage, artifactWrites } = createHarness();
    const original = await largeCover();
    imageStorage.getImageAsset.mockImplementation(async (key: string) =>
      key === COVER_KEY ? original : undefined,
    );

    const result = await service.getPublishedImage('b-1', 'u-1', 'cover-thumb');

    expect(result.contentType).toBe('image/webp');
    expect(result.filename).toBe('cover-thumb.webp');
    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBeLessThanOrEqual(COVER_THUMBNAIL_MAX_WIDTH);
    expect(meta.height).toBeLessThanOrEqual(COVER_THUMBNAIL_MAX_HEIGHT);
    expect(result.buffer.length).toBeLessThan(original.length);
    expect(imageStorage.saveImageAsset).toHaveBeenCalledWith(
      THUMB_KEY,
      result.buffer,
      'image/webp',
    );
    expect(artifactWrites.admit).toHaveBeenCalledWith('b-1', 'cover_thumbnail', [
      { store: 'image', key: THUMB_KEY },
    ]);
    expect(artifactWrites.release).toHaveBeenCalledOnce();
    expect(artifactWrites.discard).not.toHaveBeenCalled();
  });

  it('serves the derivative without caching when the book no longer admits artifact writers', async () => {
    const { service, imageStorage, artifactWrites } = createHarness();
    const original = await largeCover();
    imageStorage.getImageAsset.mockImplementation(async (key: string) =>
      key === COVER_KEY ? original : undefined,
    );
    artifactWrites.admit.mockRejectedValue(new BookArtifactWritesClosedError());

    const result = await service.getPublishedImage('b-1', 'u-1', 'cover-thumb');

    expect(result.contentType).toBe('image/webp');
    expect(imageStorage.saveImageAsset).not.toHaveBeenCalled();
    expect(artifactWrites.release).not.toHaveBeenCalled();
  });

  it('discards the intent when caching the derivative fails', async () => {
    const { service, imageStorage, artifactWrites } = createHarness();
    const original = await largeCover();
    imageStorage.getImageAsset.mockImplementation(async (key: string) =>
      key === COVER_KEY ? original : undefined,
    );
    imageStorage.saveImageAsset.mockRejectedValue(new Error('disk full'));

    const result = await service.getPublishedImage('b-1', 'u-1', 'cover-thumb');

    expect(result.contentType).toBe('image/webp');
    expect(artifactWrites.discard).toHaveBeenCalledOnce();
    expect(artifactWrites.release).not.toHaveBeenCalled();
  });

  it('serves a cached derivative without touching the full illustration', async () => {
    const { service, imageStorage } = createHarness();
    const cachedThumb = await sharp({
      create: { width: 90, height: 120, channels: 3, background: '#fff' },
    })
      .webp()
      .toBuffer();
    imageStorage.getImageAsset.mockImplementation(async (key: string) =>
      key === THUMB_KEY ? cachedThumb : undefined,
    );

    const result = await service.getPublishedImage('b-1', 'u-1', 'cover-thumb');

    expect(result.buffer).toBe(cachedThumb);
    expect(imageStorage.getImageAsset).not.toHaveBeenCalledWith(COVER_KEY);
    expect(imageStorage.saveImageAsset).not.toHaveBeenCalled();
  });

  it('resolves a different derivative key for a different publication edition', async () => {
    const { service, imageStorage } = createHarness(
      makeBook({ publishedRunId: 'run-10', publishedRunFencingVersion: 1 }),
    );
    imageStorage.getImageAsset.mockResolvedValue(undefined);

    await expect(service.getPublishedImage('b-1', 'u-1', 'cover-thumb')).rejects.toThrow(
      NotFoundException,
    );

    expect(imageStorage.getImageAsset).toHaveBeenCalledWith(
      'books/b-1/runs/run-10/claims/1/cover-thumb',
    );
    expect(imageStorage.getImageAsset).toHaveBeenCalledWith('books/b-1/runs/run-10/claims/1/cover');
  });

  it('keeps ownership and edition checks ahead of any storage read', async () => {
    const notOwned = createHarness(null);
    await expect(
      notOwned.service.getPublishedImage('b-1', 'u-other', 'cover-thumb'),
    ).rejects.toThrow(NotFoundException);
    expect(notOwned.imageStorage.getImageAsset).not.toHaveBeenCalled();

    const stale = createHarness();
    await expect(
      stale.service.getPublishedImage('b-1', 'u-1', 'cover-thumb', 'some-old-edition'),
    ).rejects.toThrow(ConflictException);
    expect(stale.imageStorage.getImageAsset).not.toHaveBeenCalled();
  });

  it('falls back to the original for vector covers and still serves when caching fails', async () => {
    const svg = createHarness();
    svg.imageStorage.getImageAsset.mockImplementation(async (key: string) =>
      key === COVER_KEY ? SVG_BYTES : undefined,
    );
    const svgResult = await svg.service.getPublishedImage('b-1', 'u-1', 'cover-thumb');
    expect(svgResult.contentType).toBe('image/svg+xml');
    expect(svg.imageStorage.saveImageAsset).not.toHaveBeenCalled();

    const failing = createHarness();
    const original = await largeCover();
    failing.imageStorage.getImageAsset.mockImplementation(async (key: string) =>
      key === COVER_KEY ? original : undefined,
    );
    failing.imageStorage.saveImageAsset.mockRejectedValue(new Error('storage down'));
    const result = await failing.service.getPublishedImage('b-1', 'u-1', 'cover-thumb');
    expect(result.contentType).toBe('image/webp');
  });
});
