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

  it('returns a current-shaped snapshot unchanged, without any DB write', async () => {
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
    });

    expect(result).toEqual(currentSnapshot);
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
    });

    expect(result).toEqual(untaggedButCurrent);
    expect(prisma.generationRun.updateMany).not.toHaveBeenCalled();
  });

  it('migrates a legacy pre-Phase-A snapshot with no photo, stamping snapshotVersion and persisting it back', async () => {
    const result = await service.normalize({
      id: 'run-1',
      bookId: 'b-1',
      inputSnapshot: PRE_PHASE_A_SNAPSHOT_NO_PHOTO,
    });

    expect(result).toEqual({
      snapshotVersion: 2,
      childName: 'Mia',
      childAge: 5,
      language: 'en',
      theme: 'friendship',
      educationalMessage: null,
      pageCount: 6,
      childPhoto: null,
    });
    expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { inputSnapshot: result },
    });
  });

  it('migrates a legacy snapshot with a photo: reads the original bytes, computes sha256/size, and writes an immutable versioned copy under a fresh key (never the original)', async () => {
    imageAssetStorage.getImageAsset.mockResolvedValue(PHOTO_BYTES);

    const result = await service.normalize({
      id: 'run-1',
      bookId: 'b-1',
      inputSnapshot: PRE_PHASE_A_SNAPSHOT_WITH_PHOTO,
    });

    expect(imageAssetStorage.getImageAsset).toHaveBeenCalledWith('b-1/child-photo-legacy');
    expect(result.childPhoto).not.toBeNull();
    expect(result.childPhoto!.assetKey).not.toBe('b-1/child-photo-legacy');
    expect(result.childPhoto!.assetKey).toMatch(/^b-1\/child-photo-/);
    expect(result.childPhoto!.sha256).toBe(createHash('sha256').update(PHOTO_BYTES).digest('hex'));
    expect(result.childPhoto!.sizeBytes).toBe(PHOTO_BYTES.length);
    expect(result.childPhoto!.contentType).toBe('image/jpeg');
    expect(imageAssetStorage.saveImageAsset).toHaveBeenCalledWith(
      result.childPhoto!.assetKey,
      PHOTO_BYTES,
      'image/jpeg',
    );
    expect(prisma.generationRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { inputSnapshot: result },
    });
  });

  it('throws InvalidGenerationInputSnapshotError (never silently dropping the photo) when the legacy photo asset has no bytes in storage', async () => {
    imageAssetStorage.getImageAsset.mockResolvedValue(undefined);

    await expect(
      service.normalize({
        id: 'run-1',
        bookId: 'b-1',
        inputSnapshot: PRE_PHASE_A_SNAPSHOT_WITH_PHOTO,
      }),
    ).rejects.toBeInstanceOf(InvalidGenerationInputSnapshotError);
    expect(imageAssetStorage.saveImageAsset).not.toHaveBeenCalled();
    expect(prisma.generationRun.updateMany).not.toHaveBeenCalled();
  });

  it('throws InvalidGenerationInputSnapshotError for a snapshot that is neither current- nor legacy-shaped', async () => {
    await expect(
      service.normalize({ id: 'run-1', bookId: 'b-1', inputSnapshot: { garbage: true } }),
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
      }),
    ).rejects.toBeInstanceOf(InvalidGenerationInputSnapshotError);
    expect(imageAssetStorage.getImageAsset).not.toHaveBeenCalled();
  });
});
