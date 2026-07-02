import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BookLayout, BookLayoutEntry } from '@book/types';
import { renderStorybookPdf } from '../pdf/pdf-renderer';
import {
  LocalImageAssetStorage,
  imageAssetKey,
  buildImageBufferResolver,
} from './image-asset-storage';

// Minimal valid 1x1 PNG (same fixture used in pdf-renderer.spec.ts).
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const TEST_BOOK_ID = 'test-image-asset-storage-001';
const TEST_DIR = resolve(process.cwd(), 'tmp', 'images', TEST_BOOK_ID);

describe('LocalImageAssetStorage', () => {
  afterEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true });
    }
  });

  it('saves and reads back PNG bytes exactly by key', async () => {
    const storage = new LocalImageAssetStorage();
    const key = `${TEST_BOOK_ID}/cover`;

    await storage.saveImageAsset(key, VALID_PNG, 'image/png');
    const read = await storage.getImageAsset(key);

    expect(read).toBeDefined();
    expect(read!.equals(VALID_PNG)).toBe(true);
  });

  it('saves and reads back JPEG and SVG content types', async () => {
    const storage = new LocalImageAssetStorage();
    const jpegKey = `${TEST_BOOK_ID}/page-1`;
    const svgKey = `${TEST_BOOK_ID}/back-cover`;
    const jpegBytes = Buffer.from('fake-jpeg-bytes');
    const svgBytes = Buffer.from('<svg></svg>');

    await storage.saveImageAsset(jpegKey, jpegBytes, 'image/jpeg');
    await storage.saveImageAsset(svgKey, svgBytes, 'image/svg+xml');

    expect((await storage.getImageAsset(jpegKey))!.equals(jpegBytes)).toBe(true);
    expect((await storage.getImageAsset(svgKey))!.equals(svgBytes)).toBe(true);
  });

  it('returns undefined for a key that was never saved', async () => {
    const storage = new LocalImageAssetStorage();
    const read = await storage.getImageAsset(`${TEST_BOOK_ID}/never-saved`);
    expect(read).toBeUndefined();
  });

  it('returns an ImageAssetRef with key, path, and contentType on save', async () => {
    const storage = new LocalImageAssetStorage();
    const key = `${TEST_BOOK_ID}/ref-check`;

    const ref = await storage.saveImageAsset(key, VALID_PNG, 'image/png');

    expect(ref.key).toBe(key);
    expect(ref.contentType).toBe('image/png');
    expect(ref.path).toMatch(/ref-check\.png$/);
    expect(existsSync(ref.path)).toBe(true);
  });

  it('rejects path-traversal keys on save', async () => {
    const storage = new LocalImageAssetStorage();
    await expect(
      storage.saveImageAsset('../evil', VALID_PNG, 'image/png'),
    ).rejects.toThrow(/Invalid image asset key/);
    await expect(
      storage.saveImageAsset(`${TEST_BOOK_ID}/../../evil`, VALID_PNG, 'image/png'),
    ).rejects.toThrow(/Invalid image asset key/);
  });

  it('rejects path-traversal keys on read', async () => {
    const storage = new LocalImageAssetStorage();
    await expect(storage.getImageAsset('../evil')).rejects.toThrow(/Invalid image asset key/);
    await expect(storage.getImageAsset('foo\\bar')).rejects.toThrow(/Invalid image asset key/);
  });

  it('rejects unsupported content types on save', async () => {
    const storage = new LocalImageAssetStorage();
    await expect(
      storage.saveImageAsset(
        `${TEST_BOOK_ID}/bad-type`,
        VALID_PNG,
        'image/gif' as never,
      ),
    ).rejects.toThrow(/Unsupported image content type/);
  });

  it('overwrites an existing key idempotently', async () => {
    const storage = new LocalImageAssetStorage();
    const key = `${TEST_BOOK_ID}/overwrite`;

    await storage.saveImageAsset(key, Buffer.from('first'), 'image/png');
    await storage.saveImageAsset(key, Buffer.from('second'), 'image/png');
    const read = await storage.getImageAsset(key);

    expect(read!.toString()).toBe('second');
  });
});

describe('imageAssetKey', () => {
  it('builds a cover key', () => {
    expect(imageAssetKey('book-1', 'cover')).toBe('book-1/cover');
  });

  it('builds a page key including the page number', () => {
    expect(imageAssetKey('book-1', 'page', 3)).toBe('book-1/page-3');
  });

  it('builds a back_cover key using a hyphen', () => {
    expect(imageAssetKey('book-1', 'back_cover')).toBe('book-1/back-cover');
  });

  it('throws when pageNumber is missing for kind "page"', () => {
    expect(() => imageAssetKey('book-1', 'page')).toThrow(/pageNumber is required/);
  });
});

// ── buildImageBufferResolver + renderStorybookPdf integration ─────────────────
// Demonstrates the full local path: bytes saved under a stable key are looked
// up per layout entry and handed to the PDF renderer's synchronous seam.

describe('buildImageBufferResolver integration with renderStorybookPdf', () => {
  const CANVAS = { width: 2400, height: 2400, unit: 'px' as const };
  const SAFE_AREA = { x: 180, y: 180, width: 2040, height: 2040 };

  function makeCoverEntry(bookId: string): BookLayoutEntry {
    return {
      id: `${bookId}-layout-cover`,
      kind: 'cover',
      template: 'cover_full_bleed',
      trimSize: 'square_8x8',
      canvas: CANVAS,
      safeArea: SAFE_AREA,
      bleed: 90,
      imageBlock: {
        box: { x: 0, y: 0, width: 2400, height: 2400 },
        imageUrl: `/mock-images/${bookId}/cover.svg`,
        altText: 'Cover illustration',
        objectFit: 'cover',
      },
      notes: [],
    };
  }

  function makeLayout(bookId: string, entries: BookLayoutEntry[]): BookLayout {
    return {
      status: 'complete',
      trimSize: 'square_8x8',
      entries,
      metadata: {
        title: 'Integration Test Book',
        childName: 'Alex',
        totalPages: 0,
        generatedAt: '1970-01-01T00:00:00.000Z',
      },
    };
  }

  afterEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true });
    }
  });

  it('embeds real bytes for a saved image asset', async () => {
    const storage = new LocalImageAssetStorage();
    const bookId = TEST_BOOK_ID;
    await storage.saveImageAsset(imageAssetKey(bookId, 'cover'), VALID_PNG, 'image/png');

    const entries = [makeCoverEntry(bookId)];
    const resolveImageBuffer = await buildImageBufferResolver(storage, bookId, entries);
    const buf = await renderStorybookPdf(makeLayout(bookId, entries), { resolveImageBuffer });

    expect(buf.toString('latin1')).toContain('/Subtype /Image');
  });

  it('falls back to the placeholder when no asset was saved for the entry', async () => {
    const storage = new LocalImageAssetStorage();
    const bookId = TEST_BOOK_ID;

    const entries = [makeCoverEntry(bookId)];
    const resolveImageBuffer = await buildImageBufferResolver(storage, bookId, entries);
    const buf = await renderStorybookPdf(makeLayout(bookId, entries), { resolveImageBuffer });

    expect(buf.toString('latin1')).not.toContain('/Subtype /Image');
  });
});
