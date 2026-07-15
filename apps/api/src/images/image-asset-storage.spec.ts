import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BookLayout, BookLayoutEntry } from '@book/types';
import { renderStorybookPdf } from '../pdf/pdf-renderer';

const sendMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  LocalImageAssetStorage,
  CloudImageAssetStorage,
  createImageAssetStorage,
  imageAssetKey,
  imageObjectKey,
  buildImageBufferResolver,
  claimImageAssetKey,
  claimCharacterSheetAssetKey,
} from './image-asset-storage';
import { InvalidGenerationArtifactPointerError } from '../agent/generation-artifact-namespace';

const validCloudEnv = {
  PDF_STORAGE_BUCKET: 'test-bucket',
  PDF_STORAGE_REGION: 'us-east-1',
  PDF_STORAGE_ACCESS_KEY_ID: 'AKIATEST',
  PDF_STORAGE_SECRET_ACCESS_KEY: 'secret-test',
};

const validCloudConfig = {
  driver: 's3' as const,
  bucket: 'test-bucket',
  region: 'us-east-1',
  accessKeyId: 'AKIATEST',
  secretAccessKey: 'secret-test',
};

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
    await expect(storage.saveImageAsset('../evil', VALID_PNG, 'image/png')).rejects.toThrow(
      /Invalid image asset key/,
    );
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
      storage.saveImageAsset(`${TEST_BOOK_ID}/bad-type`, VALID_PNG, 'image/gif' as never),
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

describe('imageObjectKey', () => {
  it('builds a namespaced key with the extension for the content type', () => {
    expect(imageObjectKey('book-1/cover', 'image/png')).toBe('images/book-1/cover.png');
    expect(imageObjectKey('book-1/page-1', 'image/jpeg')).toBe('images/book-1/page-1.jpg');
    expect(imageObjectKey('book-1/back-cover', 'image/svg+xml')).toBe(
      'images/book-1/back-cover.svg',
    );
  });

  it('rejects path-traversal keys', () => {
    expect(() => imageObjectKey('../evil', 'image/png')).toThrow(/Invalid image asset key/);
  });
});

describe('CloudImageAssetStorage', () => {
  beforeEach(() => {
    sendMock.mockReset();
    vi.mocked(PutObjectCommand).mockClear();
    vi.mocked(GetObjectCommand).mockClear();
  });

  it('constructs without making any network calls', () => {
    expect(() => new CloudImageAssetStorage(validCloudConfig)).not.toThrow();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('saveImageAsset sends PutObjectCommand with correct bucket, key, contentType, and body', async () => {
    sendMock.mockResolvedValueOnce({});
    const storage = new CloudImageAssetStorage(validCloudConfig);
    const buffer = Buffer.from('fake-png-bytes');
    const result = await storage.saveImageAsset('book-1/cover', buffer, 'image/png');

    expect(PutObjectCommand).toHaveBeenCalledWith({
      Bucket: 'test-bucket',
      Key: 'images/book-1/cover.png',
      Body: buffer,
      ContentType: 'image/png',
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      key: 'book-1/cover',
      path: 'images/book-1/cover.png',
      contentType: 'image/png',
    });
  });

  it('saveImageAsset rejects unsupported content types before sending', async () => {
    const storage = new CloudImageAssetStorage(validCloudConfig);
    await expect(
      storage.saveImageAsset('book-1/cover', Buffer.from('x'), 'image/gif' as never),
    ).rejects.toThrow(/Unsupported image content type/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('getImageAsset sends GetObjectCommand for the png key and returns the buffer on the first match', async () => {
    const pngBytes = Buffer.from('fake-png-bytes');
    sendMock.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => new Uint8Array(pngBytes) },
    });
    const storage = new CloudImageAssetStorage(validCloudConfig);
    const result = await storage.getImageAsset('book-1/cover');

    expect(GetObjectCommand).toHaveBeenCalledWith({
      Bucket: 'test-bucket',
      Key: 'images/book-1/cover.png',
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(result!.equals(pngBytes)).toBe(true);
  });

  it('getImageAsset probes subsequent extensions when earlier ones 404', async () => {
    const jpegBytes = Buffer.from('fake-jpeg-bytes');
    sendMock
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NoSuchKey' }))
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => new Uint8Array(jpegBytes) },
      });
    const storage = new CloudImageAssetStorage(validCloudConfig);
    const result = await storage.getImageAsset('book-1/page-1');

    expect(GetObjectCommand).toHaveBeenNthCalledWith(1, {
      Bucket: 'test-bucket',
      Key: 'images/book-1/page-1.png',
    });
    expect(GetObjectCommand).toHaveBeenNthCalledWith(2, {
      Bucket: 'test-bucket',
      Key: 'images/book-1/page-1.jpg',
    });
    expect(result!.equals(jpegBytes)).toBe(true);
  });

  it('getImageAsset returns undefined when every extension 404s', async () => {
    sendMock.mockRejectedValue(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
    const storage = new CloudImageAssetStorage(validCloudConfig);
    await expect(storage.getImageAsset('book-1/never-saved')).resolves.toBeUndefined();
    // One probe per supported extension: png, jpg, svg, webp.
    expect(sendMock).toHaveBeenCalledTimes(4);
  });

  it('getImageAsset rethrows non-404 errors immediately without probing further extensions', async () => {
    sendMock.mockRejectedValueOnce(new Error('access denied'));
    const storage = new CloudImageAssetStorage(validCloudConfig);
    await expect(storage.getImageAsset('book-1/cover')).rejects.toThrow(/access denied/);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('rejects for keys containing path-traversal characters', async () => {
    const storage = new CloudImageAssetStorage(validCloudConfig);
    await expect(storage.saveImageAsset('../evil', Buffer.from('x'), 'image/png')).rejects.toThrow(
      /Invalid image asset key/,
    );
    await expect(storage.getImageAsset('../evil')).rejects.toThrow(/Invalid image asset key/);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('createImageAssetStorage', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('defaults to local driver when no argument is passed', () => {
    const storage = createImageAssetStorage();
    expect(storage).toBeInstanceOf(LocalImageAssetStorage);
  });

  it('returns LocalImageAssetStorage when driver is "local"', () => {
    const storage = createImageAssetStorage('local');
    expect(storage).toBeInstanceOf(LocalImageAssetStorage);
  });

  it('returns CloudImageAssetStorage for "s3" when config is present', () => {
    const storage = createImageAssetStorage('s3', validCloudEnv);
    expect(storage).toBeInstanceOf(CloudImageAssetStorage);
  });

  it('returns CloudImageAssetStorage for "r2" when config including endpoint is present', () => {
    const storage = createImageAssetStorage('r2', {
      ...validCloudEnv,
      PDF_STORAGE_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
    });
    expect(storage).toBeInstanceOf(CloudImageAssetStorage);
  });

  it('throws a clear error naming IMAGE_STORAGE_DRIVER when required config is missing', () => {
    expect(() => createImageAssetStorage('s3', {})).toThrow(
      /IMAGE_STORAGE_DRIVER.*PDF_STORAGE_BUCKET.*PDF_STORAGE_REGION.*PDF_STORAGE_ACCESS_KEY_ID.*PDF_STORAGE_SECRET_ACCESS_KEY/,
    );
  });

  it('throws a clear error for "r2" when the endpoint is missing', () => {
    expect(() => createImageAssetStorage('r2', validCloudEnv)).toThrow(/PDF_STORAGE_ENDPOINT/);
  });

  it('throws a clear error for unsupported drivers', () => {
    expect(() => createImageAssetStorage('gcs')).toThrow(/gcs/);
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

describe('claimImageAssetKey / claimCharacterSheetAssetKey (Phase B, Slice B1)', () => {
  const RUN_A = '11111111-1111-1111-1111-111111111111';
  const RUN_B = '22222222-2222-2222-2222-222222222222';
  const claimA1 = { kind: 'claim' as const, runId: RUN_A, fencingVersion: 1 };
  const claimA2 = { kind: 'claim' as const, runId: RUN_A, fencingVersion: 2 };
  const claimB1 = { kind: 'claim' as const, runId: RUN_B, fencingVersion: 1 };

  it('produces a deterministic logical key for every artifact kind', () => {
    expect(claimImageAssetKey(TEST_BOOK_ID, claimA1, 'cover')).toBe(
      `books/${TEST_BOOK_ID}/runs/${RUN_A}/claims/1/cover`,
    );
    expect(claimImageAssetKey(TEST_BOOK_ID, claimA1, 'page', 3)).toBe(
      `books/${TEST_BOOK_ID}/runs/${RUN_A}/claims/1/page-3`,
    );
    expect(claimImageAssetKey(TEST_BOOK_ID, claimA1, 'back_cover')).toBe(
      `books/${TEST_BOOK_ID}/runs/${RUN_A}/claims/1/back-cover`,
    );
    expect(claimCharacterSheetAssetKey(TEST_BOOK_ID, claimA1)).toBe(
      `books/${TEST_BOOK_ID}/runs/${RUN_A}/claims/1/character-sheet`,
    );
  });

  it('never bakes in the S3 "images/" prefix — that stays driver-specific, exactly like imageObjectKey', () => {
    expect(claimImageAssetKey(TEST_BOOK_ID, claimA1, 'cover')).not.toContain('images/');
  });

  it('differs for the same runId across two fencing versions (stalled-redelivery reclaim)', () => {
    expect(claimImageAssetKey(TEST_BOOK_ID, claimA1, 'cover')).not.toBe(
      claimImageAssetKey(TEST_BOOK_ID, claimA2, 'cover'),
    );
  });

  it('differs for two different runIds at the same fencingVersion', () => {
    expect(claimImageAssetKey(TEST_BOOK_ID, claimA1, 'cover')).not.toBe(
      claimImageAssetKey(TEST_BOOK_ID, claimB1, 'cover'),
    );
  });

  it('requires a positive integer pageNumber for kind "page"', () => {
    expect(() => claimImageAssetKey(TEST_BOOK_ID, claimA1, 'page')).toThrow();
    expect(() => claimImageAssetKey(TEST_BOOK_ID, claimA1, 'page', 0)).toThrow();
    expect(() => claimImageAssetKey(TEST_BOOK_ID, claimA1, 'page', -1)).toThrow();
    expect(() => claimImageAssetKey(TEST_BOOK_ID, claimA1, 'page', 1.5)).toThrow();
  });

  it('rejects a malformed kind at runtime', () => {
    expect(() => claimImageAssetKey(TEST_BOOK_ID, claimA1, 'not-a-real-kind' as never)).toThrow();
  });

  it('rejects an unsafe bookId (traversal/separator)', () => {
    expect(() => claimImageAssetKey('../etc/passwd', claimA1, 'cover')).toThrow(
      InvalidGenerationArtifactPointerError,
    );
  });

  it('rejects a non-positive fencingVersion, even one constructed as a raw literal bypassing claimNamespace()', () => {
    expect(() =>
      claimImageAssetKey(TEST_BOOK_ID, { kind: 'claim', runId: RUN_A, fencingVersion: 0 }, 'cover'),
    ).toThrow(InvalidGenerationArtifactPointerError);
  });
});
