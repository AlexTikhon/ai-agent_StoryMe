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
  CopyObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  ListObjectsV2Command: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DeleteObjectsCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { LocalImageAssetStorage, CloudImageAssetStorage } from './image-asset-storage';
import { claimImageAssetKey } from './image-asset-storage';
import { claimNamespace } from '../agent/generation-artifact-namespace';

const validCloudConfig = {
  driver: 's3' as const,
  bucket: 'test-bucket',
  region: 'us-east-1',
  accessKeyId: 'AKIATEST',
  secretAccessKey: 'secret-test',
};

const TEST_BOOK_ID = 'test-image-claim-cleanup-001';
const TEST_DIR = resolve(process.cwd(), 'tmp', 'images', 'books', TEST_BOOK_ID);
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

describe('LocalImageAssetStorage.listClaimArtifacts / deleteClaimArtifacts', () => {
  afterEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true });
    }
  });

  it('lists a saved claim-scoped image with its physical key, prefixed "images/"', async () => {
    const storage = new LocalImageAssetStorage();
    const namespace = claimNamespace('run-1', 1);
    const key = claimImageAssetKey(TEST_BOOK_ID, namespace, 'cover');
    await storage.saveImageAsset(key, VALID_PNG, 'image/png');

    const page = await storage.listClaimArtifacts({ pageSize: 100 });

    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.key).toBe(
      `images/books/${TEST_BOOK_ID}/runs/run-1/claims/1/cover.png`,
    );
    expect(page.entries[0]!.size).toBeGreaterThan(0);
    expect(page.entries[0]!.lastModified).toBeInstanceOf(Date);
    expect(page.nextCursor).toBeNull();
  });

  it('never lists legacy positional keys (no "runs/claims" segment)', async () => {
    const storage = new LocalImageAssetStorage();
    // Legacy positional key: <bookId>/cover, not books/<bookId>/runs/.../claims/...
    await storage.saveImageAsset(`${TEST_BOOK_ID}-legacy/cover`, VALID_PNG, 'image/png');

    const page = await storage.listClaimArtifacts({ pageSize: 100 });

    expect(page.entries.filter((e) => e.key.includes(`${TEST_BOOK_ID}-legacy`))).toHaveLength(0);

    await rm(resolve(process.cwd(), 'tmp', 'images', `${TEST_BOOK_ID}-legacy`), {
      recursive: true,
      force: true,
    });
  });

  it('paginates deterministically with an opaque cursor', async () => {
    const storage = new LocalImageAssetStorage();
    const namespace = claimNamespace('run-1', 1);
    await storage.saveImageAsset(
      claimImageAssetKey(TEST_BOOK_ID, namespace, 'cover'),
      VALID_PNG,
      'image/png',
    );
    await storage.saveImageAsset(
      claimImageAssetKey(TEST_BOOK_ID, namespace, 'page', 1),
      VALID_PNG,
      'image/png',
    );
    await storage.saveImageAsset(
      claimImageAssetKey(TEST_BOOK_ID, namespace, 'back_cover'),
      VALID_PNG,
      'image/png',
    );

    const firstPage = await storage.listClaimArtifacts({ pageSize: 2 });
    expect(firstPage.entries).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await storage.listClaimArtifacts({
      pageSize: 2,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.entries).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();

    const allKeys = [...firstPage.entries, ...secondPage.entries].map((e) => e.key);
    expect(new Set(allKeys).size).toBe(3);
  });

  it('deletes a listed key and reports "deleted"; a repeat delete reports "not_found"', async () => {
    const storage = new LocalImageAssetStorage();
    const namespace = claimNamespace('run-1', 1);
    const key = claimImageAssetKey(TEST_BOOK_ID, namespace, 'cover');
    await storage.saveImageAsset(key, VALID_PNG, 'image/png');
    const rawKey = `images/books/${TEST_BOOK_ID}/runs/run-1/claims/1/cover.png`;

    const firstDelete = await storage.deleteClaimArtifacts([rawKey]);
    expect(firstDelete).toEqual([{ key: rawKey, outcome: 'deleted' }]);
    expect(await storage.getImageAsset(key)).toBeUndefined();

    const secondDelete = await storage.deleteClaimArtifacts([rawKey]);
    expect(secondDelete).toEqual([{ key: rawKey, outcome: 'not_found' }]);
  });

  it('refuses to delete a key that does not match the claim artifact grammar, even if asked to', async () => {
    const storage = new LocalImageAssetStorage();
    const outcomes = await storage.deleteClaimArtifacts([`images/${TEST_BOOK_ID}/cover.png`]);
    expect(outcomes).toEqual([
      {
        key: `images/${TEST_BOOK_ID}/cover.png`,
        outcome: 'failed',
        error: expect.stringContaining('grammar'),
      },
    ]);
  });
});

describe('CloudImageAssetStorage.listClaimArtifacts / deleteClaimArtifacts', () => {
  beforeEach(() => {
    sendMock.mockReset();
    vi.mocked(ListObjectsV2Command).mockClear();
    vi.mocked(DeleteObjectsCommand).mockClear();
  });

  it('lists via ListObjectsV2Command scoped to the "images/books/" prefix', async () => {
    sendMock.mockResolvedValueOnce({
      Contents: [
        { Key: 'images/books/b1/runs/r1/claims/1/cover.png', Size: 10, LastModified: new Date('2026-01-01') },
      ],
      IsTruncated: false,
    });
    const storage = new CloudImageAssetStorage(validCloudConfig);

    const page = await storage.listClaimArtifacts({ pageSize: 500 });

    expect(ListObjectsV2Command).toHaveBeenCalledWith({
      Bucket: 'test-bucket',
      Prefix: 'images/books/',
      MaxKeys: 500,
      ContinuationToken: undefined,
    });
    expect(page.entries).toEqual([
      { key: 'images/books/b1/runs/r1/claims/1/cover.png', size: 10, lastModified: new Date('2026-01-01') },
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('clamps a requested pageSize above the S3 1000-key limit', async () => {
    sendMock.mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    const storage = new CloudImageAssetStorage(validCloudConfig);

    await storage.listClaimArtifacts({ pageSize: 5000 });

    expect(ListObjectsV2Command).toHaveBeenCalledWith(
      expect.objectContaining({ MaxKeys: 1000 }),
    );
  });

  it('surfaces IsTruncated as a non-null opaque nextCursor', async () => {
    sendMock.mockResolvedValueOnce({
      Contents: [],
      IsTruncated: true,
      NextContinuationToken: 'cursor-abc',
    });
    const storage = new CloudImageAssetStorage(validCloudConfig);

    const page = await storage.listClaimArtifacts({ pageSize: 100 });

    expect(page.nextCursor).toBe('cursor-abc');
  });

  it('passes a supplied cursor through as ContinuationToken', async () => {
    sendMock.mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    const storage = new CloudImageAssetStorage(validCloudConfig);

    await storage.listClaimArtifacts({ pageSize: 100, cursor: 'cursor-abc' });

    expect(ListObjectsV2Command).toHaveBeenCalledWith(
      expect.objectContaining({ ContinuationToken: 'cursor-abc' }),
    );
  });

  it('deletes via DeleteObjectsCommand and reports per-key outcomes from Errors', async () => {
    sendMock.mockResolvedValueOnce({
      Deleted: [{ Key: 'images/books/b1/runs/r1/claims/1/cover.png' }],
      Errors: [{ Key: 'images/books/b1/runs/r1/claims/1/page-1.png', Message: 'Access Denied' }],
    });
    const storage = new CloudImageAssetStorage(validCloudConfig);

    const outcomes = await storage.deleteClaimArtifacts([
      'images/books/b1/runs/r1/claims/1/cover.png',
      'images/books/b1/runs/r1/claims/1/page-1.png',
    ]);

    expect(outcomes).toEqual([
      { key: 'images/books/b1/runs/r1/claims/1/cover.png', outcome: 'deleted' },
      {
        key: 'images/books/b1/runs/r1/claims/1/page-1.png',
        outcome: 'failed',
        error: 'Access Denied',
      },
    ]);
  });

  it('chunks a delete batch larger than 1000 keys into multiple DeleteObjectsCommand calls', async () => {
    sendMock.mockResolvedValue({ Deleted: [], Errors: [] });
    const storage = new CloudImageAssetStorage(validCloudConfig);
    const keys = Array.from(
      { length: 1500 },
      (_, i) => `images/books/b1/runs/r1/claims/1/page-${i}.png`,
    );

    await storage.deleteClaimArtifacts(keys);

    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('reports the whole batch as failed when the DeleteObjectsCommand call itself throws', async () => {
    sendMock.mockRejectedValueOnce(new Error('network blip'));
    const storage = new CloudImageAssetStorage(validCloudConfig);

    const outcomes = await storage.deleteClaimArtifacts([
      'images/books/b1/runs/r1/claims/1/cover.png',
    ]);

    expect(outcomes).toEqual([
      {
        key: 'images/books/b1/runs/r1/claims/1/cover.png',
        outcome: 'failed',
        error: 'network blip',
      },
    ]);
  });
});
