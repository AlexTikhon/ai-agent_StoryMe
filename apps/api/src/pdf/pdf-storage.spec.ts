import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';

const sendMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  HeadObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

import { PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import {
  LocalPdfStorage,
  CloudPdfStorage,
  createPdfStorage,
  assertPdfStorageSupportsWorker,
  claimPreviewPdfKey,
} from './pdf-storage';
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

const TEST_BOOK_ID = 'test-pdf-storage-spec-001';
const TEST_DIR = resolve(process.cwd(), 'tmp', 'books', TEST_BOOK_ID);

describe('LocalPdfStorage', () => {
  let storage: LocalPdfStorage;

  beforeEach(() => {
    storage = new LocalPdfStorage();
  });

  afterEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true });
    }
  });

  it('reports driver "local"', () => {
    expect(storage.driver).toBe('local');
  });

  it('creates the output directory and writes a file', async () => {
    const buffer = Buffer.from('%PDF-1.4 test');
    const result = await storage.savePreviewPdf(TEST_BOOK_ID, buffer);
    expect(result.path).toBeDefined();
    expect(existsSync(result.path!)).toBe(true);
  });

  it('written file is non-empty', async () => {
    const buffer = Buffer.from('%PDF-1.4 test content');
    const result = await storage.savePreviewPdf(TEST_BOOK_ID, buffer);
    const written = await readFile(result.path!);
    expect(written.length).toBeGreaterThan(0);
  });

  it('written file bytes match the input buffer exactly', async () => {
    const buffer = Buffer.from('%PDF-1.4 exact match test');
    const result = await storage.savePreviewPdf(TEST_BOOK_ID, buffer);
    const written = await readFile(result.path!);
    expect(written.equals(buffer)).toBe(true);
  });

  it('returns the correct url for the bookId', async () => {
    const result = await storage.savePreviewPdf(TEST_BOOK_ID, Buffer.from('%PDF'));
    expect(result.url).toBe(`/files/books/${TEST_BOOK_ID}/storybook.pdf`);
  });

  it('path ends with storybook.pdf', async () => {
    const result = await storage.savePreviewPdf(TEST_BOOK_ID, Buffer.from('%PDF'));
    expect(result.path).toMatch(/storybook\.pdf$/);
  });

  it('is idempotent — overwrites an existing file without error', async () => {
    const first = Buffer.from('%PDF-first');
    const second = Buffer.from('%PDF-second');
    const result1 = await storage.savePreviewPdf(TEST_BOOK_ID, first);
    const result2 = await storage.savePreviewPdf(TEST_BOOK_ID, second);
    expect(result1.path).toBe(result2.path);
    const written = await readFile(result2.path!);
    expect(written.equals(second)).toBe(true);
  });

  it('rejects for bookIds containing path-traversal characters', async () => {
    await expect(storage.savePreviewPdf('../evil', Buffer.from('%PDF'))).rejects.toThrow();
    await expect(storage.savePreviewPdf('foo/bar', Buffer.from('%PDF'))).rejects.toThrow();
  });

  it('accepts valid UUID-style bookIds', async () => {
    const uuidId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const dir = resolve(process.cwd(), 'tmp', 'books', uuidId);
    try {
      const result = await storage.savePreviewPdf(uuidId, Buffer.from('%PDF'));
      expect(result.url).toBe(`/files/books/${uuidId}/storybook.pdf`);
    } finally {
      if (existsSync(dir)) {
        await rm(dir, { recursive: true });
      }
    }
  });
});

describe('LocalPdfStorage.getPreviewPdf', () => {
  let storage: LocalPdfStorage;

  beforeEach(() => {
    storage = new LocalPdfStorage();
  });

  afterEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true });
    }
  });

  it('returns null when the file does not exist', async () => {
    const result = await storage.getPreviewPdf(TEST_BOOK_ID);
    expect(result).toBeNull();
  });

  it('returns a buffer matching the saved PDF after a save', async () => {
    const buffer = Buffer.from('%PDF-1.4 read-back test');
    await storage.savePreviewPdf(TEST_BOOK_ID, buffer);
    const result = await storage.getPreviewPdf(TEST_BOOK_ID);
    expect(result).not.toBeNull();
    expect(result!.buffer.equals(buffer)).toBe(true);
  });

  it('returns contentType "application/pdf"', async () => {
    await storage.savePreviewPdf(TEST_BOOK_ID, Buffer.from('%PDF'));
    const result = await storage.getPreviewPdf(TEST_BOOK_ID);
    expect(result!.contentType).toBe('application/pdf');
  });

  it('returns filename storyme-preview-<bookId>.pdf', async () => {
    await storage.savePreviewPdf(TEST_BOOK_ID, Buffer.from('%PDF'));
    const result = await storage.getPreviewPdf(TEST_BOOK_ID);
    expect(result!.filename).toBe(`storyme-preview-${TEST_BOOK_ID}.pdf`);
  });

  it('rejects for bookIds containing path-traversal characters', async () => {
    await expect(storage.getPreviewPdf('../evil')).rejects.toThrow();
    await expect(storage.getPreviewPdf('foo/bar')).rejects.toThrow();
  });
});

describe('LocalPdfStorage.previewPdfExists', () => {
  let storage: LocalPdfStorage;

  beforeEach(() => {
    storage = new LocalPdfStorage();
  });

  afterEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true });
    }
  });

  it('returns false when no preview has been saved', async () => {
    await expect(storage.previewPdfExists(TEST_BOOK_ID)).resolves.toBe(false);
  });

  it('returns true after a preview has been saved', async () => {
    await storage.savePreviewPdf(TEST_BOOK_ID, Buffer.from('%PDF'));
    await expect(storage.previewPdfExists(TEST_BOOK_ID)).resolves.toBe(true);
  });

  it('rejects for bookIds containing path-traversal characters', async () => {
    await expect(storage.previewPdfExists('../evil')).rejects.toThrow();
    await expect(storage.previewPdfExists('foo/bar')).rejects.toThrow();
  });
});

describe('CloudPdfStorage', () => {
  beforeEach(() => {
    sendMock.mockReset();
    vi.mocked(PutObjectCommand).mockClear();
    vi.mocked(GetObjectCommand).mockClear();
    vi.mocked(HeadObjectCommand).mockClear();
  });

  it('constructs without making any network calls', () => {
    expect(() => new CloudPdfStorage(validCloudConfig)).not.toThrow();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('reports the configured driver (s3 or r2)', () => {
    expect(new CloudPdfStorage(validCloudConfig).driver).toBe('s3');
    expect(new CloudPdfStorage({ ...validCloudConfig, driver: 'r2' }).driver).toBe('r2');
  });

  it('a PDF saved by one instance (simulating the worker process) is readable by a separate instance (simulating the API process) against the same bucket', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 cross-process test');
    sendMock.mockResolvedValueOnce({}); // worker's PutObjectCommand
    const workerStorage = new CloudPdfStorage(validCloudConfig);
    await workerStorage.savePreviewPdf('book-shared', pdfBytes);

    sendMock.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => new Uint8Array(pdfBytes) },
    }); // api's GetObjectCommand
    const apiStorage = new CloudPdfStorage(validCloudConfig);
    const result = await apiStorage.getPreviewPdf('book-shared');

    expect(result).not.toBeNull();
    expect(result!.buffer.equals(pdfBytes)).toBe(true);
  });

  it('savePreviewPdf sends PutObjectCommand with correct bucket, key, contentType, and body', async () => {
    sendMock.mockResolvedValueOnce({});
    const storage = new CloudPdfStorage(validCloudConfig);
    const buffer = Buffer.from('%PDF-1.4 test');
    const result = await storage.savePreviewPdf('book-1', buffer);

    expect(PutObjectCommand).toHaveBeenCalledWith({
      Bucket: 'test-bucket',
      Key: 'previews/book-1/storyme-preview-book-1.pdf',
      Body: buffer,
      ContentType: 'application/pdf',
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(result.url).toBe('previews/book-1/storyme-preview-book-1.pdf');
  });

  it('getPreviewPdf sends GetObjectCommand and returns Buffer + metadata', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 read-back');
    sendMock.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => new Uint8Array(pdfBytes) },
    });
    const storage = new CloudPdfStorage(validCloudConfig);
    const result = await storage.getPreviewPdf('book-1');

    expect(GetObjectCommand).toHaveBeenCalledWith({
      Bucket: 'test-bucket',
      Key: 'previews/book-1/storyme-preview-book-1.pdf',
    });
    expect(result).not.toBeNull();
    expect(result!.buffer.equals(pdfBytes)).toBe(true);
    expect(result!.contentType).toBe('application/pdf');
    expect(result!.filename).toBe('storyme-preview-book-1.pdf');
  });

  it('getPreviewPdf returns null for a missing object (NoSuchKey)', async () => {
    sendMock.mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
    const storage = new CloudPdfStorage(validCloudConfig);
    await expect(storage.getPreviewPdf('book-1')).resolves.toBeNull();
  });

  it('getPreviewPdf returns null for a missing object (404 status metadata)', async () => {
    sendMock.mockRejectedValueOnce(
      Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } }),
    );
    const storage = new CloudPdfStorage(validCloudConfig);
    await expect(storage.getPreviewPdf('book-1')).resolves.toBeNull();
  });

  it('getPreviewPdf rethrows non-404 errors', async () => {
    sendMock.mockRejectedValueOnce(new Error('access denied'));
    const storage = new CloudPdfStorage(validCloudConfig);
    await expect(storage.getPreviewPdf('book-1')).rejects.toThrow(/access denied/);
  });

  it('previewPdfExists sends HeadObjectCommand and returns true when it succeeds', async () => {
    sendMock.mockResolvedValueOnce({});
    const storage = new CloudPdfStorage(validCloudConfig);
    await expect(storage.previewPdfExists('book-1')).resolves.toBe(true);
    expect(HeadObjectCommand).toHaveBeenCalledWith({
      Bucket: 'test-bucket',
      Key: 'previews/book-1/storyme-preview-book-1.pdf',
    });
  });

  it('previewPdfExists returns false for NotFound', async () => {
    sendMock.mockRejectedValueOnce(Object.assign(new Error('nf'), { name: 'NotFound' }));
    const storage = new CloudPdfStorage(validCloudConfig);
    await expect(storage.previewPdfExists('book-1')).resolves.toBe(false);
  });

  it('previewPdfExists returns false for NoSuchKey', async () => {
    sendMock.mockRejectedValueOnce(Object.assign(new Error('nsk'), { name: 'NoSuchKey' }));
    const storage = new CloudPdfStorage(validCloudConfig);
    await expect(storage.previewPdfExists('book-1')).resolves.toBe(false);
  });

  it('rejects for bookIds containing path-traversal characters', async () => {
    const storage = new CloudPdfStorage(validCloudConfig);
    await expect(storage.savePreviewPdf('../evil', Buffer.from('%PDF'))).rejects.toThrow();
    await expect(storage.getPreviewPdf('foo/bar')).rejects.toThrow();
    await expect(storage.previewPdfExists('../evil')).rejects.toThrow();
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('createPdfStorage', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('defaults to local driver when no argument is passed', () => {
    const storage = createPdfStorage();
    expect(storage).toBeInstanceOf(LocalPdfStorage);
  });

  it('returns LocalPdfStorage when driver is "local"', () => {
    const storage = createPdfStorage('local');
    expect(storage).toBeInstanceOf(LocalPdfStorage);
  });

  it('returns CloudPdfStorage for "s3" when config is present', () => {
    const storage = createPdfStorage('s3', validCloudEnv);
    expect(storage).toBeInstanceOf(CloudPdfStorage);
  });

  it('returns CloudPdfStorage for "r2" when config including endpoint is present', () => {
    const storage = createPdfStorage('r2', {
      ...validCloudEnv,
      PDF_STORAGE_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
    });
    expect(storage).toBeInstanceOf(CloudPdfStorage);
  });

  it('throws a clear error for "s3" when required config is missing', () => {
    expect(() => createPdfStorage('s3', {})).toThrow(
      /PDF_STORAGE_BUCKET.*PDF_STORAGE_REGION.*PDF_STORAGE_ACCESS_KEY_ID.*PDF_STORAGE_SECRET_ACCESS_KEY/,
    );
  });

  it('throws a clear error for "r2" when the endpoint is missing', () => {
    expect(() => createPdfStorage('r2', validCloudEnv)).toThrow(/PDF_STORAGE_ENDPOINT/);
  });

  it('throws a clear error for unsupported drivers', () => {
    expect(() => createPdfStorage('gcs')).toThrow(/gcs/);
  });

  it('error message names the unsupported driver', () => {
    expect(() => createPdfStorage('gcs')).toThrow(/gcs/);
  });
});

describe('assertPdfStorageSupportsWorker', () => {
  it('throws a clear, actionable error when NODE_ENV=production and PDF_STORAGE_DRIVER is local', () => {
    expect(() =>
      assertPdfStorageSupportsWorker({ NODE_ENV: 'production', PDF_STORAGE_DRIVER: 'local' }),
    ).toThrow(/PDF_STORAGE_DRIVER=local cannot be used by the generation worker in production/);
  });

  it('throws when NODE_ENV=production and PDF_STORAGE_DRIVER is unset (defaults to local)', () => {
    expect(() => assertPdfStorageSupportsWorker({ NODE_ENV: 'production' })).toThrow(
      /PDF_STORAGE_DRIVER=local cannot be used/,
    );
  });

  it('does not throw when NODE_ENV=production and PDF_STORAGE_DRIVER is s3 or r2', () => {
    expect(() =>
      assertPdfStorageSupportsWorker({ NODE_ENV: 'production', PDF_STORAGE_DRIVER: 's3' }),
    ).not.toThrow();
    expect(() =>
      assertPdfStorageSupportsWorker({ NODE_ENV: 'production', PDF_STORAGE_DRIVER: 'r2' }),
    ).not.toThrow();
  });

  it('does not throw outside production regardless of driver', () => {
    expect(() =>
      assertPdfStorageSupportsWorker({ NODE_ENV: 'development', PDF_STORAGE_DRIVER: 'local' }),
    ).not.toThrow();
    expect(() => assertPdfStorageSupportsWorker({})).not.toThrow();
  });
});

describe('claimPreviewPdfKey (Phase B, Slice B1)', () => {
  const RUN_A = '11111111-1111-1111-1111-111111111111';
  const RUN_B = '22222222-2222-2222-2222-222222222222';
  const claimA1 = { kind: 'claim' as const, runId: RUN_A, fencingVersion: 1 };
  const claimA2 = { kind: 'claim' as const, runId: RUN_A, fencingVersion: 2 };
  const claimB1 = { kind: 'claim' as const, runId: RUN_B, fencingVersion: 1 };

  it('produces the expected deterministic logical key', () => {
    expect(claimPreviewPdfKey(TEST_BOOK_ID, claimA1)).toBe(
      `books/${TEST_BOOK_ID}/runs/${RUN_A}/claims/1/storyme-preview-${TEST_BOOK_ID}.pdf`,
    );
  });

  it('never bakes in the S3 "previews/" prefix — that stays driver-specific, exactly like objectKey', () => {
    expect(claimPreviewPdfKey(TEST_BOOK_ID, claimA1)).not.toContain('previews/');
  });

  it('differs for the same runId across two fencing versions (stalled-redelivery reclaim)', () => {
    expect(claimPreviewPdfKey(TEST_BOOK_ID, claimA1)).not.toBe(
      claimPreviewPdfKey(TEST_BOOK_ID, claimA2),
    );
  });

  it('differs for two different runIds at the same fencingVersion', () => {
    expect(claimPreviewPdfKey(TEST_BOOK_ID, claimA1)).not.toBe(
      claimPreviewPdfKey(TEST_BOOK_ID, claimB1),
    );
  });

  it('rejects an unsafe bookId (traversal/separator)', () => {
    expect(() => claimPreviewPdfKey('../etc/passwd', claimA1)).toThrow();
  });

  it('rejects an invalid claim namespace (non-positive fencingVersion), even one constructed as a raw literal bypassing claimNamespace()', () => {
    expect(() =>
      claimPreviewPdfKey(TEST_BOOK_ID, { kind: 'claim', runId: RUN_A, fencingVersion: 0 }),
    ).toThrow(InvalidGenerationArtifactPointerError);
  });

  it('produces logically identical keys to what CloudPdfStorage/LocalPdfStorage would need for the same claim (local/cloud parity)', () => {
    // claimPreviewPdfKey is the single logical-key source both a future local
    // and cloud PdfStorage driver would build their own path/object key from
    // (mirroring how imageObjectKey/LocalImageAssetStorage share one key
    // today) — calling it twice for the same inputs must be deterministic.
    const first = claimPreviewPdfKey(TEST_BOOK_ID, claimA1);
    const second = claimPreviewPdfKey(TEST_BOOK_ID, claimA1);
    expect(first).toBe(second);
  });
});
