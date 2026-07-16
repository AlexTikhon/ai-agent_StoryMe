import { describe, it, expect, vi } from 'vitest';
import type { ImageAssetStorage, ImageAssetRef } from '../images/image-asset-storage';
import { claimImageAssetKey, claimCharacterSheetAssetKey } from '../images/image-asset-storage';
import { LEGACY_NAMESPACE, type ClaimArtifactNamespace } from './generation-artifact-namespace';
import { resolveCharacterSheetArtifact, resolveImageArtifact } from './generation-claim-artifacts';

const BOOK_ID = 'book-1';
const RUN_A = 'run-a';
const RUN_B = 'run-b';
const CLAIM_A1: ClaimArtifactNamespace = { kind: 'claim', runId: RUN_A, fencingVersion: 1 };
const CLAIM_A2: ClaimArtifactNamespace = { kind: 'claim', runId: RUN_A, fencingVersion: 2 };
const CLAIM_B1: ClaimArtifactNamespace = { kind: 'claim', runId: RUN_B, fencingVersion: 1 };

/** Minimal in-memory ImageAssetStorage mirroring LocalImageAssetStorage's contracts (undefined for a genuinely missing key, propagate everything else). */
class FakeImageAssetStorage implements ImageAssetStorage {
  private readonly data = new Map<string, Buffer>();

  seed(key: string, buffer: Buffer): void {
    this.data.set(key, buffer);
  }

  saveImageAsset = vi.fn(async (key: string, buffer: Buffer): Promise<ImageAssetRef> => {
    this.data.set(key, buffer);
    return { key, path: key, contentType: 'image/png' };
  });

  getImageAsset = vi.fn(async (key: string): Promise<Buffer | undefined> => this.data.get(key));

  copyImageAsset = vi.fn(
    async (sourceKey: string, destinationKey: string): Promise<ImageAssetRef | undefined> => {
      const buffer = this.data.get(sourceKey);
      if (buffer == null) return undefined;
      this.data.set(destinationKey, buffer);
      return { key: destinationKey, path: destinationKey, contentType: 'image/png' };
    },
  );
}

describe('resolveImageArtifact', () => {
  it('reuses a valid current-claim image without consulting the source at all', async () => {
    const storage = new FakeImageAssetStorage();
    storage.seed(claimImageAssetKey(BOOK_ID, CLAIM_A1, 'cover'), Buffer.from('current-bytes'));

    const result = await resolveImageArtifact({
      storage,
      bookId: BOOK_ID,
      currentNamespace: CLAIM_A1,
      sourceNamespace: CLAIM_B1,
      kind: 'cover',
    });

    expect(result).toEqual({
      key: claimImageAssetKey(BOOK_ID, CLAIM_A1, 'cover'),
      outcome: 'reused',
      sourceStatus: 'not-checked',
    });
    expect(storage.copyImageAsset).not.toHaveBeenCalled();
  });

  it('copies a valid legacy-positional source into the current claim namespace', async () => {
    const storage = new FakeImageAssetStorage();
    storage.seed('book-1/cover', Buffer.from('legacy-bytes'));

    const result = await resolveImageArtifact({
      storage,
      bookId: BOOK_ID,
      currentNamespace: CLAIM_A1,
      sourceNamespace: LEGACY_NAMESPACE,
      kind: 'cover',
    });

    expect(result.outcome).toBe('copied');
    expect(result.sourceStatus).toBe('valid');
    expect(storage.copyImageAsset).toHaveBeenCalledWith(
      'book-1/cover',
      claimImageAssetKey(BOOK_ID, CLAIM_A1, 'cover'),
    );
    expect(
      (await storage.getImageAsset(claimImageAssetKey(BOOK_ID, CLAIM_A1, 'cover')))!.equals(
        Buffer.from('legacy-bytes'),
      ),
    ).toBe(true);
  });

  it('copies a valid source from a different run into the current claim namespace', async () => {
    const storage = new FakeImageAssetStorage();
    storage.seed(claimImageAssetKey(BOOK_ID, CLAIM_B1, 'page', 3), Buffer.from('run-b-bytes'));

    const result = await resolveImageArtifact({
      storage,
      bookId: BOOK_ID,
      currentNamespace: CLAIM_A1,
      sourceNamespace: CLAIM_B1,
      kind: 'page',
      pageNumber: 3,
    });

    expect(result.outcome).toBe('copied');
    expect(storage.copyImageAsset).toHaveBeenCalledWith(
      claimImageAssetKey(BOOK_ID, CLAIM_B1, 'page', 3),
      claimImageAssetKey(BOOK_ID, CLAIM_A1, 'page', 3),
    );
  });

  it('copies from a prior claim of the same run (a stalled-redelivery reclaim bumps fencingVersion, not runId)', async () => {
    const storage = new FakeImageAssetStorage();
    storage.seed(claimImageAssetKey(BOOK_ID, CLAIM_A1, 'cover'), Buffer.from('claim-1-bytes'));

    const result = await resolveImageArtifact({
      storage,
      bookId: BOOK_ID,
      currentNamespace: CLAIM_A2,
      sourceNamespace: CLAIM_A1,
      kind: 'cover',
    });

    expect(result.outcome).toBe('copied');
    expect(storage.copyImageAsset).toHaveBeenCalledWith(
      claimImageAssetKey(BOOK_ID, CLAIM_A1, 'cover'),
      claimImageAssetKey(BOOK_ID, CLAIM_A2, 'cover'),
    );
  });

  it('never consults the source when currentNamespace and sourceNamespace resolve to the identical namespace', async () => {
    const storage = new FakeImageAssetStorage();

    const result = await resolveImageArtifact({
      storage,
      bookId: BOOK_ID,
      currentNamespace: CLAIM_A1,
      sourceNamespace: CLAIM_A1,
      kind: 'cover',
    });

    expect(result).toEqual({
      key: claimImageAssetKey(BOOK_ID, CLAIM_A1, 'cover'),
      outcome: 'regenerate',
      sourceStatus: 'not-checked',
    });
    expect(storage.getImageAsset).toHaveBeenCalledTimes(1);
    expect(storage.copyImageAsset).not.toHaveBeenCalled();
  });

  it('falls through to regeneration when no source namespace applies at all (e.g. a fresh claim with no resumable JSON)', async () => {
    const storage = new FakeImageAssetStorage();

    const result = await resolveImageArtifact({
      storage,
      bookId: BOOK_ID,
      currentNamespace: CLAIM_A1,
      sourceNamespace: null,
      kind: 'cover',
    });

    expect(result.outcome).toBe('regenerate');
    expect(result.sourceStatus).toBe('not-checked');
    expect(storage.copyImageAsset).not.toHaveBeenCalled();
  });

  it('falls through to regeneration with sourceStatus "missing" when the source was never saved', async () => {
    const storage = new FakeImageAssetStorage();

    const result = await resolveImageArtifact({
      storage,
      bookId: BOOK_ID,
      currentNamespace: CLAIM_A1,
      sourceNamespace: CLAIM_B1,
      kind: 'cover',
    });

    expect(result.outcome).toBe('regenerate');
    expect(result.sourceStatus).toBe('missing');
    expect(storage.copyImageAsset).not.toHaveBeenCalled();
  });

  it('falls through to regeneration with sourceStatus "invalid" when the source is a zero-byte file, without attempting a copy', async () => {
    const storage = new FakeImageAssetStorage();
    storage.seed(claimImageAssetKey(BOOK_ID, CLAIM_B1, 'cover'), Buffer.alloc(0));

    const result = await resolveImageArtifact({
      storage,
      bookId: BOOK_ID,
      currentNamespace: CLAIM_A1,
      sourceNamespace: CLAIM_B1,
      kind: 'cover',
    });

    expect(result.outcome).toBe('regenerate');
    expect(result.sourceStatus).toBe('invalid');
    expect(storage.copyImageAsset).not.toHaveBeenCalled();
  });

  it('falls back to regeneration (sourceStatus "missing") when copyImageAsset resolves undefined because the source disappeared mid-flight', async () => {
    const storage = new FakeImageAssetStorage();
    storage.seed(claimImageAssetKey(BOOK_ID, CLAIM_B1, 'cover'), Buffer.from('bytes'));
    storage.copyImageAsset.mockResolvedValueOnce(undefined);

    const result = await resolveImageArtifact({
      storage,
      bookId: BOOK_ID,
      currentNamespace: CLAIM_A1,
      sourceNamespace: CLAIM_B1,
      kind: 'cover',
    });

    expect(result.outcome).toBe('regenerate');
    expect(result.sourceStatus).toBe('missing');
  });

  it('propagates an operational copy error instead of reclassifying it as a missing source', async () => {
    const storage = new FakeImageAssetStorage();
    storage.seed(claimImageAssetKey(BOOK_ID, CLAIM_B1, 'cover'), Buffer.from('bytes'));
    storage.copyImageAsset.mockRejectedValueOnce(new Error('access denied'));

    await expect(
      resolveImageArtifact({
        storage,
        bookId: BOOK_ID,
        currentNamespace: CLAIM_A1,
        sourceNamespace: CLAIM_B1,
        kind: 'cover',
      }),
    ).rejects.toThrow('access denied');
  });

  it('propagates an operational getImageAsset error on the current-claim check', async () => {
    const storage = new FakeImageAssetStorage();
    storage.getImageAsset.mockRejectedValueOnce(new Error('network error'));

    await expect(
      resolveImageArtifact({
        storage,
        bookId: BOOK_ID,
        currentNamespace: CLAIM_A1,
        sourceNamespace: CLAIM_B1,
        kind: 'cover',
      }),
    ).rejects.toThrow('network error');
  });

  it('falls through to regeneration when the copy lands but a verification read finds it zero-byte', async () => {
    const storage = new FakeImageAssetStorage();
    storage.seed(claimImageAssetKey(BOOK_ID, CLAIM_B1, 'cover'), Buffer.from('bytes'));
    // Simulate a copy that "succeeds" per the driver but leaves nothing
    // readable back at the destination.
    storage.copyImageAsset.mockImplementationOnce(async (_source, dest) => ({
      key: dest,
      path: dest,
      contentType: 'image/png' as const,
    }));

    const result = await resolveImageArtifact({
      storage,
      bookId: BOOK_ID,
      currentNamespace: CLAIM_A1,
      sourceNamespace: CLAIM_B1,
      kind: 'cover',
    });

    expect(result.outcome).toBe('regenerate');
    expect(result.sourceStatus).toBe('invalid');
  });
});

describe('resolveCharacterSheetArtifact', () => {
  it('reuses a valid current-claim sheet without consulting the source', async () => {
    const storage = new FakeImageAssetStorage();
    storage.seed(claimCharacterSheetAssetKey(BOOK_ID, CLAIM_A1), Buffer.from('sheet-bytes'));

    const result = await resolveCharacterSheetArtifact({
      storage,
      bookId: BOOK_ID,
      currentNamespace: CLAIM_A1,
      sourceNamespace: LEGACY_NAMESPACE,
    });

    expect(result.outcome).toBe('reused');
    expect(storage.copyImageAsset).not.toHaveBeenCalled();
  });

  it('copies a valid legacy source sheet into the current claim namespace', async () => {
    const storage = new FakeImageAssetStorage();
    storage.seed('book-1/character-sheet', Buffer.from('legacy-sheet'));

    const result = await resolveCharacterSheetArtifact({
      storage,
      bookId: BOOK_ID,
      currentNamespace: CLAIM_A1,
      sourceNamespace: LEGACY_NAMESPACE,
    });

    expect(result.outcome).toBe('copied');
    expect(storage.copyImageAsset).toHaveBeenCalledWith(
      'book-1/character-sheet',
      claimCharacterSheetAssetKey(BOOK_ID, CLAIM_A1),
    );
  });

  it('regenerates when the source sheet is missing or invalid', async () => {
    const storage = new FakeImageAssetStorage();

    const result = await resolveCharacterSheetArtifact({
      storage,
      bookId: BOOK_ID,
      currentNamespace: CLAIM_A1,
      sourceNamespace: CLAIM_B1,
    });

    expect(result.outcome).toBe('regenerate');
    expect(result.sourceStatus).toBe('missing');
  });
});
