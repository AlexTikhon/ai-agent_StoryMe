import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { GenerationInputSnapshotBackfillService } from './generation-input-snapshot-backfill.service';
import {
  InvalidGenerationInputSnapshotError,
  hashInputSnapshot,
} from './generation-input-snapshot';
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
    prisma.book.updateMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) => cb(prisma));
    imageAssetStorage = createMockImageAssetStorage();
    service = new GenerationInputSnapshotBackfillService(prisma as never, imageAssetStorage);
  });

  it('returns a current-shaped snapshot paired with the run row own inputHash, without any DB write, when the stored hash already matches', async () => {
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
    const matchingHash = hashInputSnapshot(currentSnapshot);

    const result = await service.normalize({
      id: 'run-1',
      bookId: 'b-1',
      inputSnapshot: currentSnapshot,
      inputHash: matchingHash,
    });

    expect(result).toEqual({ snapshot: currentSnapshot, inputHash: matchingHash });
    expect(prisma.generationRun.updateMany).not.toHaveBeenCalled();
    expect(prisma.book.updateMany).not.toHaveBeenCalled();
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
    const matchingHash = hashInputSnapshot(untaggedButCurrent);

    const result = await service.normalize({
      id: 'run-1',
      bookId: 'b-1',
      inputSnapshot: untaggedButCurrent,
      inputHash: matchingHash,
    });

    expect(result).toEqual({ snapshot: untaggedButCurrent, inputHash: matchingHash });
    expect(prisma.generationRun.updateMany).not.toHaveBeenCalled();
  });

  it('repairs (and returns the true hash for) a current-shaped snapshot whose stored inputHash does not match hashInputSnapshot(inputSnapshot)', async () => {
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
    const trueHash = hashInputSnapshot(currentSnapshot);

    const result = await service.normalize({
      id: 'run-1',
      bookId: 'b-1',
      inputSnapshot: currentSnapshot,
      inputHash: 'deliberately-wrong-hash',
    });

    // The contract holds regardless of the stored column: the returned hash
    // is always hashInputSnapshot(snapshot).
    expect(result).toEqual({ snapshot: currentSnapshot, inputHash: trueHash });
    expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', inputHash: 'deliberately-wrong-hash' },
      data: { inputHash: trueHash },
    });
  });

  it('migrates Book.lastGenerationInputHash alongside the repaired GenerationRun.inputHash when it still matches the pre-repair value', async () => {
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
    const trueHash = hashInputSnapshot(currentSnapshot);

    const result = await service.normalize({
      id: 'run-1',
      bookId: 'b-1',
      inputSnapshot: currentSnapshot,
      inputHash: 'deliberately-wrong-hash',
    });

    expect(prisma.book.updateMany).toHaveBeenCalledWith({
      where: { id: 'b-1', lastGenerationInputHash: 'deliberately-wrong-hash' },
      data: { lastGenerationInputHash: result.inputHash },
    });
    expect(result.inputHash).toBe(trueHash);
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
    // Book.lastGenerationInputHash is migrated in lockstep when it still
    // holds this exact run's pre-migration ('stale-legacy-hash') value —
    // see issue #1: a legacy run that reached the layout phase before
    // failing stamps that hash onto Book, and a later retry must be able to
    // match it against the migrated (current-shaped) hash.
    expect(prisma.book.updateMany).toHaveBeenCalledWith({
      where: { id: 'b-1', lastGenerationInputHash: 'stale-legacy-hash' },
      data: { lastGenerationInputHash: result.inputHash },
    });
  });

  it("leaves Book.lastGenerationInputHash untouched when it does not match this run's pre-migration hash (it was stamped by a different run)", async () => {
    prisma.book.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.normalize({
      id: 'run-1',
      bookId: 'b-1',
      inputSnapshot: PRE_PHASE_A_SNAPSHOT_NO_PHOTO,
      inputHash: 'stale-legacy-hash',
    });

    expect(prisma.book.updateMany).toHaveBeenCalledWith({
      where: { id: 'b-1', lastGenerationInputHash: 'stale-legacy-hash' },
      data: { lastGenerationInputHash: result.inputHash },
    });
    // Result is unaffected either way — the CAS guard only protects the
    // Book row itself, never this method's return value.
    expect(result.inputHash).not.toBe('stale-legacy-hash');
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
      const winnerHash = hashInputSnapshot(winnerSnapshot);
      // First CAS attempt loses (count 0) — someone else already migrated
      // this run between our read and our write.
      prisma.generationRun.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.generationRun.findUniqueOrThrow.mockResolvedValue({
        id: 'run-1',
        bookId: 'b-1',
        inputSnapshot: winnerSnapshot,
        inputHash: winnerHash,
      });

      const result = await service.normalize({
        id: 'run-1',
        bookId: 'b-1',
        inputSnapshot: PRE_PHASE_A_SNAPSHOT_NO_PHOTO,
        inputHash: 'stale-legacy-hash',
      });

      // Converged on the winner's already-current snapshot/hash, not this
      // caller's own (now-discarded) locally-computed migration.
      expect(result).toEqual({ snapshot: winnerSnapshot, inputHash: winnerHash });
      // Only one migration write was ever attempted by this caller.
      expect(prisma.generationRun.updateMany).toHaveBeenCalledTimes(1);
    });

    it('a legacy snapshot with a photo still writes its own versioned copy to storage even when it goes on to lose the CAS race — the bytes are never lost, just left unreferenced', async () => {
      imageAssetStorage.getImageAsset.mockResolvedValue(PHOTO_BYTES);
      prisma.generationRun.updateMany.mockResolvedValueOnce({ count: 0 });
      const winnerSnapshot = {
        snapshotVersion: 2 as const,
        childName: 'Mia',
        childAge: 5,
        language: 'en',
        theme: 'friendship',
        educationalMessage: null,
        pageCount: 6,
        childPhoto: {
          assetKey: 'b-1/child-photo-winner',
          sha256: createHash('sha256').update(PHOTO_BYTES).digest('hex'),
          contentType: 'image/jpeg' as const,
          sizeBytes: PHOTO_BYTES.length,
        },
      };
      prisma.generationRun.findUniqueOrThrow.mockResolvedValue({
        id: 'run-1',
        bookId: 'b-1',
        inputSnapshot: winnerSnapshot,
        inputHash: hashInputSnapshot(winnerSnapshot),
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
