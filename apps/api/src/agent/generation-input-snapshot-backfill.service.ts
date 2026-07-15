import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  IMAGE_ASSET_STORAGE_TOKEN,
  childPhotoAssetKey,
  type ImageAssetStorage,
} from '../images/image-asset-storage';
import { isAllowedChildPhotoMimeType } from '../books/child-photo.constants';
import {
  CURRENT_SNAPSHOT_VERSION,
  InvalidGenerationInputSnapshotError,
  generationInputSnapshotSchema,
  legacyGenerationInputSnapshotSchemaV1,
  type GenerationInputSnapshot,
  type LegacyGenerationInputSnapshotV1,
} from './generation-input-snapshot';

/** The subset of a GenerationRun's fields normalize() actually needs. */
export interface SnapshotBearingRun {
  readonly id: string;
  readonly bookId: string;
  readonly inputSnapshot: unknown;
}

/**
 * Migrates a GenerationRun's stored `inputSnapshot` forward from the
 * pre-Phase-A shape (legacyGenerationInputSnapshotSchemaV1 — a bare
 * childPhotoAssetKey/childPhotoContentType, no versioned photo identity, no
 * snapshotVersion tag at all) to the current shape, the first time it is
 * read after this phase deploys. Safe to call on a run in any status
 * (queued/running/failed/completed) — it only ever reads+rewrites the
 * `inputSnapshot` JSON column itself, never touches status/fencing, so it
 * can never race or conflict with claim/heartbeat/completeRun.
 *
 * A legacy snapshot with no photo is normalized in-memory with no I/O. A
 * legacy snapshot *with* a photo requires reading the existing asset bytes
 * once, computing sha256/size, and writing an immutable *versioned* copy
 * under a fresh key (never overwriting the original) — mirroring
 * BooksService.uploadChildPhoto's own versioning invariant, so this migrated
 * run's frozen photo identity can never be invalidated by a later re-upload
 * either. The rewritten snapshot is persisted back to the run so this
 * migration only ever needs to happen once per run.
 */
@Injectable()
export class GenerationInputSnapshotBackfillService {
  private readonly logger = new Logger(GenerationInputSnapshotBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(IMAGE_ASSET_STORAGE_TOKEN) private readonly imageAssetStorage: ImageAssetStorage,
  ) {}

  /**
   * Returns the run's snapshot in the current shape, migrating and
   * persisting it first if it's still legacy-shaped. Throws
   * InvalidGenerationInputSnapshotError (the same stable code as
   * parseGenerationInputSnapshot) for anything that is neither current- nor
   * legacy-shaped, or whose legacy photo can no longer be safely migrated
   * (e.g. the original asset bytes are gone) — callers already treat that
   * error as a permanent, non-retryable failure (see
   * GenerationQueueProcessor.process / BooksService.retryGeneration).
   */
  async normalize(run: SnapshotBearingRun): Promise<GenerationInputSnapshot> {
    const current = generationInputSnapshotSchema.safeParse(run.inputSnapshot);
    if (current.success) return current.data;

    const legacy = legacyGenerationInputSnapshotSchemaV1.safeParse(run.inputSnapshot);
    if (!legacy.success) {
      throw new InvalidGenerationInputSnapshotError(run.id, current.error);
    }

    const migrated = await this.migrateLegacy(run.id, run.bookId, legacy.data);
    await this.prisma.generationRun.updateMany({
      where: { id: run.id },
      data: { inputSnapshot: migrated as unknown as Prisma.InputJsonValue },
    });
    this.logger.log(
      `Migrated legacy (pre-Phase-A) input_snapshot for run ${run.id} (book ${run.bookId}) to snapshotVersion ${CURRENT_SNAPSHOT_VERSION}.`,
    );
    return migrated;
  }

  private async migrateLegacy(
    runId: string,
    bookId: string,
    legacy: LegacyGenerationInputSnapshotV1,
  ): Promise<GenerationInputSnapshot> {
    const base = {
      snapshotVersion: CURRENT_SNAPSHOT_VERSION as typeof CURRENT_SNAPSHOT_VERSION,
      childName: legacy.childName,
      childAge: legacy.childAge,
      language: legacy.language,
      theme: legacy.theme,
      educationalMessage: legacy.educationalMessage,
      pageCount: legacy.pageCount,
    };

    // No photo on the legacy snapshot — do not silently discard one just
    // because it wasn't there to begin with; there is nothing to migrate.
    if (!legacy.childPhotoAssetKey) {
      return { ...base, childPhoto: null };
    }

    if (
      !legacy.childPhotoContentType ||
      !isAllowedChildPhotoMimeType(legacy.childPhotoContentType)
    ) {
      throw new InvalidGenerationInputSnapshotError(
        runId,
        new Error(
          `legacy input_snapshot has childPhotoAssetKey "${legacy.childPhotoAssetKey}" but an unusable childPhotoContentType "${String(legacy.childPhotoContentType)}"`,
        ),
      );
    }

    // The existing Book child photo must never be silently discarded just
    // because the new digest columns are null on a legacy row — read the
    // bytes for real and compute the identity now, rather than treating a
    // legacy photo as if none had ever been uploaded.
    const bytes = await this.imageAssetStorage.getImageAsset(legacy.childPhotoAssetKey);
    if (!bytes) {
      throw new InvalidGenerationInputSnapshotError(
        runId,
        new Error(
          `legacy input_snapshot's childPhotoAssetKey "${legacy.childPhotoAssetKey}" (book ${bookId}) has no bytes in image storage — cannot safely backfill a versioned identity for it`,
        ),
      );
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // A fresh versioned key, never the original — mirrors
    // BooksService.uploadChildPhoto so this migrated run's frozen identity
    // can never be invalidated by a later re-upload landing on the same key.
    const versionedKey = childPhotoAssetKey(bookId, randomUUID());
    await this.imageAssetStorage.saveImageAsset(versionedKey, bytes, legacy.childPhotoContentType);

    return {
      ...base,
      childPhoto: {
        assetKey: versionedKey,
        sha256,
        contentType: legacy.childPhotoContentType,
        sizeBytes: bytes.length,
      },
    };
  }
}
