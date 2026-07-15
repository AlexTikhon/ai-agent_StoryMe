import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { GenerationInputSnapshotBackfillService } from './generation-input-snapshot-backfill.service';
import { InvalidGenerationInputSnapshotError } from './generation-input-snapshot';
import { createMockPrisma } from '../common/test-utils/mock-prisma';
import type { ImageAssetStorage } from '../images/image-asset-storage';

/** The exact pre-Phase-A GenerationRun.input_snapshot JSON shape: no snapshotVersion, a bare childPhotoAssetKey/childPhotoContentType instead of childPhoto's full versioned identity object. */
const PRE_PHASE_A_SNAPSHOT_NO_PHOTO = {
  childName: 'Mia',
  childAge: 5,
  language: 'en',
  theme: 'friendship',
  educationalMessage: null,
  pageCount: 6,
  childPhotoAssetKey: null,
  childPhotoContentType: null,
};

const PHOTO_BYTES = Buffer.from('legacy-photo-bytes');

const PRE_PHASE_A_SNAPSHOT_WITH_PHOTO = {
  childName: 'Mia',
  childAge: 5,
  language: 'en',
  theme: 'friendship',
  educationalMessage: null,
  pageCount: 6,
  childPhotoAssetKey: 'b-1/child-photo-legacy',
  childPhotoContentType: 'image/jpeg',
};

function createMockImageAssetStorage(): jest.Mocked<ImageAssetStorage> {
  return {
    saveImageAsset: vi.fn().mockResolvedValue({ key: 'k', path: 'k', contentType: 'image/jpeg' }),
    getImageAsset: vi.fn(),
  } as unknown as jest.Mocked<ImageAssetStorage>;
}

describe('GenerationInputSnapshotBackfillService', () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let imageAssetStorage: ReturnType<typeof createMockImageAssetStorage>;
  let service: GenerationInputSnapshotBackfillService;

  beforeEach(() => {
    prisma = createMockPrisma();
    prisma.generationRun.updateMany.mockResolvedValue({ count: 1 });
    imageAssetStorage = createMockImageAssetStorage();
    service = new GenerationInputSnapshotBackfillService(prisma as never, imageAssetStorage);
  });

  it('returns a current-shaped snapshot paired with the run row own inputHash, without any DB write', async () => {
    const currentSnapshot = {
      snapshotVersion: 2,
      childName: 'Alex',
      childAge: 6,
      language: 'en',
      theme: 'adventure',
      educationalMessage: null,
      pageCount: 6,
      childPhoto: null,
    };

    const result = await service.normalize({
      id: 'run-1',
      bookId: 'b-1',
      inputSnapshot: currentSnapshot,
      inputHash: 'hash-1',
    });

    expect(result).toEqual({ snapshot: currentSnapshot, inputHash: 'hash-1' });
    expect(prisma.generationRun.updateMany).not.toHaveBeenCalled();
  });

  it('treats a current-shaped snapshot missing the snapshotVersion tag as current (no legacy migration triggered)', async () => {
    const untaggedButCurrent = {
      childName: 'Alex',
      childAge: 6,
      language: 'en',
      theme: 'adventure',
      educationalMessage: null,
      pageCount: 6,
      childPhoto: null,
    };

    const result = await service.normalize({
      id: 'run-1',
      bookId: 'b-1',
      inputSnapshot: untaggedButCurrent,
      inputHash: 'hash-1',
    });

    expect(result).toEqual({ snapshot: untaggedButCurrent, inputHash: 'hash-1' });
    expect(prisma.generationRun.updateMany).not.toHaveBeenCalled();
  });

  it('migrates a legacy pre-Phase-A snapshot with no photo, stamping snapshotVersion and persisting the snapshot AND a freshly-computed inputHash together', async () => {
    const result = await service.normalize({
      id: 'run-1',
      bookId: 'b-1',
      inputSnapshot: PRE_PHASE_A_SNAPSHOT_NO_PHOTO,
      inputHash: 'stale-legacy-hash',
    });

    expect(result.snapshot).toEqual({
      snapshotVersion: 2,
      childName: 'Mia',
      childAge: 5,
      language: 'en',
      theme: 'friendship',
      educationalMessage: null,
      pageCount: 6,
      childPhoto: null,
    });
    // The migration must never leave the persisted inputHash column
    // pointing at the pre-migration ('stale-legacy-hash') value — see the
    // service's own "Snapshot/hash invariant" doc comment.
    expect(result.inputHash).not.toBe('stale-legacy-hash');
    expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', inputSnapshot: { equals: PRE_PHASE_A_SNAPSHOT_NO_PHOTO } },
      data: { inputSnapshot: result.snapshot, inputHash: result.inputHash },
    });
  });

  it('migrates a legacy snapshot with a photo: reads the original bytes, computes sha256/size, and writes an immutable versioned copy under a fresh key (never the original)', async () => {
    imageAssetStorage.getImageAsset.mockResolvedValue(PHOTO_BYTES);

    const result = await service.normalize({
      id: 'run-1',
      bookId: 'b-1',
      inputSnapshot: PRE_PHASE_A_SNAPSHOT_WITH_PHOTO,
      inputHash: 'stale-legacy-hash',
    });

    expect(imageAssetStorage.getImageAsset).toHaveBeenCalledWith('b-1/child-photo-legacy');
    const { childPhoto } = result.snapshot;
    expect(childPhoto).not.toBeNull();
    expect(childPhoto!.assetKey).not.toBe('b-1/child-photo-legacy');
    expect(childPhoto!.assetKey).toMatch(/^b-1\/child-photo-/);
    expect(childPhoto!.sha256).toBe(createHash('sha256').update(PHOTO_BYTES).digest('hex'));
    expect(childPhoto!.sizeBytes).toBe(PHOTO_BYTES.length);
    expect(childPhoto!.contentType).toBe('image/jpeg');
    expect(imageAssetStorage.saveImageAsset).toHaveBeenCalledWith(
      childPhoto!.assetKey,
      PHOTO_BYTES,
      'image/jpeg',
    );
    expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', inputSnapshot: { equals: PRE_PHASE_A_SNAPSHOT_WITH_PHOTO } },
      data: { inputSnapshot: result.snapshot, inputHash: result.inputHash },
    });
  });

  it('throws InvalidGenerationInputSnapshotError (never silently dropping the photo) when the legacy photo asset has no bytes in storage', async () => {
    imageAssetStorage.getImageAsset.mockResolvedValue(undefined);

    await expect(
      service.normalize({
        id: 'run-1',
        bookId: 'b-1',
        inputSnapshot: PRE_PHASE_A_SNAPSHOT_WITH_PHOTO,
        inputHash: 'hash-1',
      }),
    ).rejects.toBeInstanceOf(InvalidGenerationInputSnapshotError);
    expect(imageAssetStorage.saveImageAsset).not.toHaveBeenCalled();
    expect(prisma.generationRun.updateMany).not.toHaveBeenCalled();
  });

  it('throws InvalidGenerationInputSnapshotError for a snapshot that is neither current- nor legacy-shaped', async () => {
    await expect(
      service.normalize({
        id: 'run-1',
        bookId: 'b-1',
        inputSnapshot: { garbage: true },
        inputHash: 'hash-1',
      }),
    ).rejects.toBeInstanceOf(InvalidGenerationInputSnapshotError);
    expect(prisma.generationRun.updateMany).not.toHaveBeenCalled();
  });

  it('throws InvalidGenerationInputSnapshotError for a legacy snapshot whose childPhotoContentType is not an allowed mime type', async () => {
    await expect(
      service.normalize({
        id: 'run-1',
        bookId: 'b-1',
        inputSnapshot: {
          ...PRE_PHASE_A_SNAPSHOT_WITH_PHOTO,
          childPhotoContentType: 'application/pdf',
        },
        inputHash: 'hash-1',
      }),
    ).rejects.toBeInstanceOf(InvalidGenerationInputSnapshotError);
    expect(imageAssetStorage.getImageAsset).not.toHaveBeenCalled();
  });

  describe('concurrent migration', () => {
    it('when the CAS write loses a race (another caller already migrated this run), re-reads the row and converges on the winning migration instead of trusting its own locally-computed copy', async () => {
      const winnerSnapshot = {
        snapshotVersion: 2 as const,
        childName: 'Mia',
        childAge: 5,
        language: 'en',
        theme: 'friendship',
        educationalMessage: null,
        pageCount: 6,
        childPhoto: null,
      };
      // First CAS attempt loses (count 0) — someone else already migrated
      // this run between our read and our write.
      prisma.generationRun.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.generationRun.findUniqueOrThrow.mockResolvedValue({
        id: 'run-1',
        bookId: 'b-1',
        inputSnapshot: winnerSnapshot,
        inputHash: 'winner-hash',
      });

      const result = await service.normalize({
        id: 'run-1',
        bookId: 'b-1',
        inputSnapshot: PRE_PHASE_A_SNAPSHOT_NO_PHOTO,
        inputHash: 'stale-legacy-hash',
      });

      // Converged on the winner's already-current snapshot/hash, not this
      // caller's own (now-discarded) locally-computed migration.
      expect(result).toEqual({ snapshot: winnerSnapshot, inputHash: 'winner-hash' });
      // Only one migration write was ever attempted by this caller.
      expect(prisma.generationRun.updateMany).toHaveBeenCalledTimes(1);
    });

    it('a legacy snapshot with a photo still writes its own versioned copy to storage even when it goes on to lose the CAS race — the bytes are never lost, just left unreferenced', async () => {
      imageAssetStorage.getImageAsset.mockResolvedValue(PHOTO_BYTES);
      prisma.generationRun.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.generationRun.findUniqueOrThrow.mockResolvedValue({
        id: 'run-1',
        bookId: 'b-1',
        inputSnapshot: {
          snapshotVersion: 2,
          childName: 'Mia',
          childAge: 5,
          language: 'en',
          theme: 'friendship',
          educationalMessage: null,
          pageCount: 6,
          childPhoto: {
            assetKey: 'b-1/child-photo-winner',
            sha256: createHash('sha256').update(PHOTO_BYTES).digest('hex'),
            contentType: 'image/jpeg',
            sizeBytes: PHOTO_BYTES.length,
          },
        },
        inputHash: 'winner-hash',
      });

      const result = await service.normalize({
        id: 'run-1',
        bookId: 'b-1',
        inputSnapshot: PRE_PHASE_A_SNAPSHOT_WITH_PHOTO,
        inputHash: 'stale-legacy-hash',
      });

      // This caller's own migration ran (and saved its own versioned copy)
      // before losing the race — the legacy photo is never lost even though
      // this particular copy ends up unreferenced.
      expect(imageAssetStorage.saveImageAsset).toHaveBeenCalledTimes(1);
      // But the returned identity is the winner's, not this caller's own.
      expect(result.snapshot.childPhoto?.assetKey).toBe('b-1/child-photo-winner');
    });

    it('throws a clear error rather than looping forever if the CAS write keeps losing past the retry bound', async () => {
      prisma.generationRun.updateMany.mockResolvedValue({ count: 0 });
      prisma.generationRun.findUniqueOrThrow.mockResolvedValue({
        id: 'run-1',
        bookId: 'b-1',
        inputSnapshot: PRE_PHASE_A_SNAPSHOT_NO_PHOTO,
        inputHash: 'stale-legacy-hash',
      });

      await expect(
        service.normalize({
          id: 'run-1',
          bookId: 'b-1',
          inputSnapshot: PRE_PHASE_A_SNAPSHOT_NO_PHOTO,
          inputHash: 'stale-legacy-hash',
        }),
      ).rejects.toThrow(/did not converge/);
    });
  });
});
