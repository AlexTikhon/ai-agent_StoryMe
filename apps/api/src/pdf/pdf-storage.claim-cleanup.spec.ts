import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const sendMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  HeadObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  ListObjectsV2Command: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DeleteObjectsCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { LocalPdfStorage, CloudPdfStorage, claimPreviewPdfKey } from './pdf-storage';
import { claimNamespace } from '../agent/generation-artifact-namespace';

const validCloudConfig = {
  driver: 's3' as const,
  bucket: 'test-bucket',
  region: 'us-east-1',
  accessKeyId: 'AKIATEST',
  secretAccessKey: 'secret-test',
};

const TEST_BOOK_ID = 'test-pdf-claim-cleanup-001';
const TEST_DIR = resolve(process.cwd(), 'tmp', 'books', TEST_BOOK_ID);

describe('LocalPdfStorage.listClaimArtifacts / deleteClaimArtifacts', () => {
  afterEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true });
    }
  });

  it('lists a saved claim-scoped PDF with its physical key', async () => {
    const storage = new LocalPdfStorage();
    const namespace = claimNamespace('run-1', 1);
    await storage.saveClaimPreviewPdf(TEST_BOOK_ID, namespace, Buffer.from('%PDF-claim'));

    const page = await storage.listClaimArtifacts({ pageSize: 100 });

    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.key).toBe(claimPreviewPdfKey(TEST_BOOK_ID, namespace));
    expect(page.entries[0]!.size).toBeGreaterThan(0);
    expect(page.nextCursor).toBeNull();
  });

  it('never lists the legacy positional PDF ("books/<bookId>/storybook.pdf"), even though it shares the same "books/" root as claim PDFs', async () => {
    const storage = new LocalPdfStorage();
    await storage.savePreviewPdf(TEST_BOOK_ID, Buffer.from('%PDF-legacy'));
    const namespace = claimNamespace('run-1', 1);
    await storage.saveClaimPreviewPdf(TEST_BOOK_ID, namespace, Buffer.from('%PDF-claim'));

    const page = await storage.listClaimArtifacts({ pageSize: 100 });

    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.key).toBe(claimPreviewPdfKey(TEST_BOOK_ID, namespace));
  });

  it('deletes a listed claim PDF and leaves a sibling legacy PDF for the same book untouched', async () => {
    const storage = new LocalPdfStorage();
    await storage.savePreviewPdf(TEST_BOOK_ID, Buffer.from('%PDF-legacy'));
    const namespace = claimNamespace('run-1', 1);
    await storage.saveClaimPreviewPdf(TEST_BOOK_ID, namespace, Buffer.from('%PDF-claim'));
    const key = claimPreviewPdfKey(TEST_BOOK_ID, namespace);

    const outcomes = await storage.deleteClaimArtifacts([key]);

    expect(outcomes).toEqual([{ key, outcome: 'deleted' }]);
    expect(await storage.claimPreviewPdfExists(TEST_BOOK_ID, namespace)).toBe(false);
    expect(await storage.previewPdfExists(TEST_BOOK_ID)).toBe(true);
  });

  it('refuses to delete a key that does not match the claim artifact grammar', async () => {
    const storage = new LocalPdfStorage();
    const outcomes = await storage.deleteClaimArtifacts([`books/${TEST_BOOK_ID}/storybook.pdf`]);
    expect(outcomes).toEqual([
      {
        key: `books/${TEST_BOOK_ID}/storybook.pdf`,
        outcome: 'failed',
        error: expect.stringContaining('grammar'),
      },
    ]);
  });
});

describe('CloudPdfStorage.listClaimArtifacts / deleteClaimArtifacts', () => {
  beforeEach(() => {
    sendMock.mockReset();
    vi.mocked(ListObjectsV2Command).mockClear();
    vi.mocked(DeleteObjectsCommand).mockClear();
  });

  it('lists via ListObjectsV2Command scoped to the "books/" prefix', async () => {
    sendMock.mockResolvedValueOnce({
      Contents: [
        {
          Key: 'books/b1/runs/r1/claims/1/storyme-preview-b1.pdf',
          Size: 20,
          LastModified: new Date('2026-01-01'),
        },
      ],
      IsTruncated: false,
    });
    const storage = new CloudPdfStorage(validCloudConfig);

    const page = await storage.listClaimArtifacts({ pageSize: 500 });

    expect(ListObjectsV2Command).toHaveBeenCalledWith({
      Bucket: 'test-bucket',
      Prefix: 'books/',
      MaxKeys: 500,
      ContinuationToken: undefined,
    });
    expect(page.entries).toEqual([
      {
        key: 'books/b1/runs/r1/claims/1/storyme-preview-b1.pdf',
        size: 20,
        lastModified: new Date('2026-01-01'),
      },
    ]);
  });

  it('deletes via DeleteObjectsCommand and reports per-key outcomes', async () => {
    sendMock.mockResolvedValueOnce({
      Deleted: [{ Key: 'books/b1/runs/r1/claims/1/storyme-preview-b1.pdf' }],
      Errors: [],
    });
    const storage = new CloudPdfStorage(validCloudConfig);

    const outcomes = await storage.deleteClaimArtifacts([
      'books/b1/runs/r1/claims/1/storyme-preview-b1.pdf',
    ]);

    expect(outcomes).toEqual([
      { key: 'books/b1/runs/r1/claims/1/storyme-preview-b1.pdf', outcome: 'deleted' },
    ]);
  });
});
