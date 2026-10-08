import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimNamespace } from '../agent/generation-artifact-namespace';
import { CloudImageAssetStorage, LocalImageAssetStorage } from '../images/image-asset-storage';
import { CloudPdfStorage, LocalPdfStorage } from '../pdf/pdf-storage';

const CLOUD_CONFIG = {
  driver: 's3' as const,
  bucket: 'unit-bucket',
  region: 'us-east-1',
  accessKeyId: 'not-a-real-key',
  secretAccessKey: 'not-a-real-secret',
};
const KEY = 'b-1/child-photo-abc';
const NAMESPACE = claimNamespace('11111111-1111-1111-1111-111111111111', 1);

describe('exact-artifact delete primitives (local, real temp directory)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'storyme-delete-primitives-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('LocalImageAssetStorage.deleteImageAsset removes every extension and is idempotent', async () => {
    const storage = new LocalImageAssetStorage(root);
    await storage.saveImageAsset(KEY, Buffer.from('png'), 'image/png');
    await storage.saveImageAsset(KEY, Buffer.from('webp'), 'image/webp');
    await storage.saveImageAsset('b-1/other', Buffer.from('keep'), 'image/png');

    await storage.deleteImageAsset(KEY);
    await storage.deleteImageAsset(KEY);

    expect(await storage.getImageAsset(KEY)).toBeUndefined();
    expect(await storage.getImageAsset('b-1/other')).toBeDefined();
    expect(await readdir(join(root, 'images', 'b-1'))).toEqual(['other.png']);
  });

  it('LocalImageAssetStorage.deleteImageAsset rejects traversal keys', async () => {
    await expect(new LocalImageAssetStorage(root).deleteImageAsset('../escape')).rejects.toThrow(
      /Invalid image asset key/,
    );
  });

  it('LocalPdfStorage.deleteClaimPreviewPdf removes only that claim PDF and is idempotent', async () => {
    const storage = new LocalPdfStorage(root);
    const other = claimNamespace('22222222-2222-2222-2222-222222222222', 1);
    await storage.saveClaimPreviewPdf('b-1', NAMESPACE, Buffer.from('%PDF-a'));
    await storage.saveClaimPreviewPdf('b-1', other, Buffer.from('%PDF-b'));

    await storage.deleteClaimPreviewPdf('b-1', NAMESPACE);
    await storage.deleteClaimPreviewPdf('b-1', NAMESPACE);

    expect(await storage.claimPreviewPdfExists('b-1', NAMESPACE)).toBe(false);
    expect(await storage.claimPreviewPdfExists('b-1', other)).toBe(true);
  });
});

describe('exact-artifact delete primitives (cloud, mocked client)', () => {
  it('CloudImageAssetStorage.deleteImageAsset deletes every supported extension of the key', async () => {
    const storage = new CloudImageAssetStorage(CLOUD_CONFIG);
    const send = vi.fn().mockResolvedValue({ Errors: [] });
    (storage as unknown as { client: { send: typeof send } }).client = { send };

    await storage.deleteImageAsset(KEY);

    const input = send.mock.calls[0]![0].input;
    expect(input.Bucket).toBe('unit-bucket');
    expect(input.Delete.Objects.map((o: { Key: string }) => o.Key).sort()).toEqual([
      `images/${KEY}.jpg`,
      `images/${KEY}.png`,
      `images/${KEY}.svg`,
      `images/${KEY}.webp`,
    ]);
  });

  it('CloudImageAssetStorage.deleteImageAsset fails on per-object errors instead of reporting success', async () => {
    const storage = new CloudImageAssetStorage(CLOUD_CONFIG);
    const send = vi.fn().mockResolvedValue({ Errors: [{ Key: `images/${KEY}.png` }] });
    (storage as unknown as { client: { send: typeof send } }).client = { send };

    await expect(storage.deleteImageAsset(KEY)).rejects.toThrow(/per-object errors/);
  });

  it('CloudPdfStorage.deleteClaimPreviewPdf deletes exactly the claim key', async () => {
    const storage = new CloudPdfStorage(CLOUD_CONFIG);
    const send = vi.fn().mockResolvedValue({});
    (storage as unknown as { client: { send: typeof send } }).client = { send };

    await storage.deleteClaimPreviewPdf('b-1', NAMESPACE);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0].input).toEqual({
      Bucket: 'unit-bucket',
      Key: expect.stringContaining('books/b-1/'),
    });
  });

  it('CloudPdfStorage.deleteClaimPreviewPdf propagates provider failures', async () => {
    const storage = new CloudPdfStorage(CLOUD_CONFIG);
    (storage as unknown as { client: { send: () => Promise<never> } }).client = {
      send: () => Promise.reject(new Error('denied')),
    };

    await expect(storage.deleteClaimPreviewPdf('b-1', NAMESPACE)).rejects.toThrow('denied');
  });
});
