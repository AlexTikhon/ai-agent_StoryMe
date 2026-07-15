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
  hashInputSnapshot,
  legacyGenerationInputSnapshotSchemaV1,
  type GenerationInputSnapshot,
  type LegacyGenerationInputSnapshotV1,
} from './generation-input-snapshot';

/** The subset of a GenerationRun's fields normalize() actually needs. */
export interface SnapshotBearingRun {
  readonly id: string;
  readonly bookId: string;
  readonly inputSnapshot: unknown;
  readonly inputHash: string;
}

/**
 * normalize()'s result: the current-shaped snapshot, paired with the exact
 * inputHash that describes it (`hashInputSnapshot(snapshot)`), so a caller
 * building a GenerationExecutionContext or comparing against
 * Book.lastGenerationInputHash never has to separately recompute or
 * (incorrectly) reuse the run's original, possibly-legacy-shaped inputHash —
 * see this file's own doc comment for why that pairing matters.
 */
export interface NormalizedGenerationInput {
  readonly snapshot: GenerationInputSnapshot;
  readonly inputHash: string;
}

/** Bound on normalize()'s CAS-retry loop (see its doc comment) — purely a safety net against a pathological, never-converging write storm; a real migration race resolves in one retry. */
const MAX_MIGRATION_CAS_ATTEMPTS = 5;

/**
 * Migrates a GenerationRun's stored `inputSnapshot` forward from the
 * pre-Phase-A shape (legacyGenerationInputSnapshotSchemaV1 — a bare
 * childPhotoAssetKey/childPhotoContentType, no versioned photo identity, no
 * snapshotVersion tag at all) to the current shape, the first time it is
 * read after this phase deploys. Safe to call on a run in any status
 * (queued/running/failed/completed) — it only ever reads+rewrites the
 * `inputSnapshot`/`inputHash` columns themselves, never touches
 * status/fencing, so it can never race or conflict with
 * claim/heartbeat/completeRun.
 *
 * **Snapshot/hash invariant**: the `inputHash` this method returns is always
 * exactly `hashInputSnapshot(snapshot)` for the `snapshot` returned alongside
 * it — never a stale value read off the run row before migration. Before this
 * was enforced here, a legacy run's `inputHash` column was left exactly as it
 * was pre-migration (computed over the old, differently-shaped JSON) while
 * `inputSnapshot` was rewritten to the current shape — so a later retry,
 * which always recomputes its own new run's inputHash fresh from *its*
 * (already-current) copy of the snapshot (see BooksService.
 * createRunAndSchedule), would compute a hash that could never equal
 * `Book.lastGenerationInputHash` (stamped from the *stale* hash the first,
 * migrated run actually executed under). `AgentService.isResumableBook`
 * gates purely on that equality, so the mismatch didn't corrupt anything —
 * it just silently forced a full, unnecessary regeneration on every retry of
 * a migrated run instead of resuming. Callers must always use the `inputHash`
 * this method returns (never a run's own `.inputHash` field read
 * separately) precisely so migration can never desynchronize the pair again.
 *
 * A legacy snapshot with no photo is normalized in-memory with no I/O. A
 * legacy snapshot *with* a photo requires reading the existing asset bytes
 * once, computing sha256/size, and writing an immutable *versioned* copy
 * under a fresh key (never overwriting the original) — mirroring
 * BooksService.uploadChildPhoto's own versioning invariant, so this migrated
 * run's frozen photo identity can never be invalidated by a later re-upload
 * either.
 *
 * **Concurrency**: two callers can legitimately race to migrate the *same*
 * run (e.g. two concurrent `retryGeneration` requests for the same book, both
 * reading the same prior run before either has created a new one — the
 * per-book "one active run" guard only rejects the loser at run-*creation*
 * time, after both may have already reached here). The migration write is a
 * compare-and-swap keyed on the run's original (pre-migration) inputSnapshot
 * value, not a blind `updateMany({ where: { id } })`: exactly one racer's
 * write actually lands. The other(s) detect zero rows matched, re-read the
 * now-migrated row, and recurse — converging on whichever migration won
 * rather than each trusting its own locally-computed copy (which would be
 * "last write wins" on the run's own snapshot/hash pair, and could hand a
 * caller back a photo identity/hash the run row no longer agrees with). Every
 * racer's own versioned photo-asset write to ImageAssetStorage still happens
 * (storage has no CAS primitive here), so a losing racer's copy is left
 * unreferenced rather than deleted — the same accepted, documented cleanup
 * debt as BooksService.uploadChildPhoto's own re-upload versioning. What this
 * guarantees is that the legacy photo itself is never lost (every racer
 * either wins or safely converges on someone else's equally valid migration)
 * and that the run's own persisted inputSnapshot/inputHash pair is always
 * self-consistent, never a torn mix of two racers' writes.
 */
@Injectable()
export class GenerationInputSnapshotBackfillService {
  private readonly logger = new Logger(GenerationInputSnapshotBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(IMAGE_ASSET_STORAGE_TOKEN) private readonly imageAssetStorage: ImageAssetStorage,
  ) {}

  /**
   * Returns the run's snapshot in the current shape (migrating and
   * persisting it first if it's still legacy-shaped) paired with the exact
   * inputHash that describes it — see this class's doc comment for why the
   * two must always travel together. Throws
   * InvalidGenerationInputSnapshotError (the same stable code as
   * parseGenerationInputSnapshot) for anything that is neither current- nor
   * legacy-shaped, or whose legacy photo can no longer be safely migrated
   * (e.g. the original asset bytes are gone) — callers already treat that
   * error as a permanent, non-retryable failure (see
   * GenerationQueueProcessor.process / BooksService.retryGeneration).
   */
  async normalize(run: SnapshotBearingRun, attempt = 1): Promise<NormalizedGenerationInput> {
    const current = generationInputSnapshotSchema.safeParse(run.inputSnapshot);
    if (current.success) {
      // Trusted as-is: createRunAndSchedule always writes inputHash and
      // inputSnapshot together for a freshly-created run, and this method is
      // the only other writer of either column (see the CAS write below,
      // which keeps them paired too) — the invariant holds by construction.
      return { snapshot: current.data, inputHash: run.inputHash };
    }

    const legacy = legacyGenerationInputSnapshotSchemaV1.safeParse(run.inputSnapshot);
    if (!legacy.success) {
      throw new InvalidGenerationInputSnapshotError(run.id, current.error);
    }

    if (attempt > MAX_MIGRATION_CAS_ATTEMPTS) {
      throw new Error(
        `GenerationRun ${run.id}'s legacy input_snapshot migration did not converge after ${MAX_MIGRATION_CAS_ATTEMPTS} attempts — persistent concurrent writers to the same run's inputSnapshot column, which should never happen.`,
      );
    }

    const migrated = await this.migrateLegacy(run.id, run.bookId, legacy.data);
    const inputHash = hashInputSnapshot(migrated);

    // Compare-and-swap on the exact pre-migration snapshot value, not a
    // blind `where: { id }` — see this class's "Concurrency" doc comment. A
    // second concurrent migrator's write here matches zero rows and must not
    // be treated as success.
    const persisted = await this.prisma.generationRun.updateMany({
      where: { id: run.id, inputSnapshot: { equals: run.inputSnapshot as Prisma.InputJsonValue } },
      data: {
        inputSnapshot: migrated as unknown as Prisma.InputJsonValue,
        inputHash,
      },
    });
    if (persisted.count === 0) {
      const fresh = await this.prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      return this.normalize(fresh, attempt + 1);
    }

    this.logger.log(
      `Migrated legacy (pre-Phase-A) input_snapshot for run ${run.id} (book ${run.bookId}) to snapshotVersion ${CURRENT_SNAPSHOT_VERSION}.`,
    );
    return { snapshot: migrated, inputHash };
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
