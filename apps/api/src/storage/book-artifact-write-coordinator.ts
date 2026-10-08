import { Inject, Injectable, Logger } from '@nestjs/common';
import { BookArtifactWriteState, Prisma, type BookArtifactWriteIntent } from '@prisma/client';
import { claimNamespace } from '../agent/generation-artifact-namespace';
import { PrismaService } from '../database/prisma.service';
import { IMAGE_ASSET_STORAGE_TOKEN, type ImageAssetStorage } from '../images/image-asset-storage';
import { PDF_STORAGE_TOKEN, type PdfStorage } from '../pdf/pdf-storage';

export const DEFAULT_BOOK_ARTIFACT_WRITE_LEASE_MS = 10 * 60 * 1000;

/** Reads BOOK_ARTIFACT_WRITE_LEASE_MS, falling back to a safe default when missing or malformed. */
export function readBookArtifactWriteLeaseMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['BOOK_ARTIFACT_WRITE_LEASE_MS'];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BOOK_ARTIFACT_WRITE_LEASE_MS;
}

/** The book is tombstoned, soft-deleted, or gone: no new artifact writer may be admitted. */
export class BookArtifactWritesClosedError extends Error {
  constructor() {
    super('Artifact writes are closed for this book');
    this.name = 'BookArtifactWritesClosedError';
  }
}

/** The intent was reaped or already resolved, so its artifacts may not be published. */
export class BookArtifactWriteFencedError extends Error {
  constructor() {
    super('Artifact write intent was fenced');
    this.name = 'BookArtifactWriteFencedError';
  }
}

export type BookArtifactRef =
  { store: 'image'; key: string } | { store: 'pdf'; runId: string; fencingVersion: number };

export interface BookArtifactWriteHandle {
  readonly id: string;
  readonly bookId: string;
}

export interface BookArtifactRecoverySummary {
  cleaned: number;
  failed: number;
}

function parseArtifacts(value: Prisma.JsonValue): BookArtifactRef[] {
  if (!Array.isArray(value)) throw new Error('Malformed artifact write intent');
  return value.map((entry) => {
    const item = entry as Record<string, unknown> | null;
    if (item?.['store'] === 'image' && typeof item['key'] === 'string') {
      return { store: 'image', key: item['key'] };
    }
    if (
      item?.['store'] === 'pdf' &&
      typeof item['runId'] === 'string' &&
      typeof item['fencingVersion'] === 'number'
    ) {
      return { store: 'pdf', runId: item['runId'], fencingVersion: item['fencingVersion'] };
    }
    throw new Error('Malformed artifact write intent');
  });
}

/**
 * Coordinates API-side writers into a book's artifact namespace with permanent
 * book deletion. The contract (see docs/CURRENT_PRODUCT.md, "Artifact writes
 * and permanent deletion"):
 *
 *  - admit() inserts a durable `active` intent while holding a shared row lock
 *    on the live Book row. Hard deletion tombstones that same row, so every
 *    admission is totally ordered against it: an intent either committed before
 *    the tombstone (and deletion must account for it) or admission fails.
 *  - A writer then performs its external I/O OUTSIDE any transaction and
 *    consumes the intent in the same transaction that publishes its artifact
 *    (releaseInTransaction). A reaped intent cannot be consumed, so a fenced
 *    writer can never publish.
 *  - A writer that did not publish calls discard(): the intent flips to
 *    `cleanup_pending` (the durable cleanup record), the exact artifacts are
 *    deleted and verified absent, and only then is the record removed. A crash
 *    or storage failure at any step leaves the record for recoverStale().
 *
 * What this does NOT claim: an `active` intent whose lease has expired is
 * *reaped* (fenced + queued for cleanup), which is a liveness decision, not
 * proof that a stalled process stopped writing. See the limitations section of
 * the documentation.
 */
@Injectable()
export class BookArtifactWriteCoordinator {
  private readonly logger = new Logger(BookArtifactWriteCoordinator.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(IMAGE_ASSET_STORAGE_TOKEN) private readonly imageStorage: ImageAssetStorage,
    @Inject(PDF_STORAGE_TOKEN) private readonly pdfStorage: PdfStorage,
  ) {}

  async admit(
    bookId: string,
    kind: string,
    artifacts: readonly BookArtifactRef[],
  ): Promise<BookArtifactWriteHandle> {
    const leaseExpiresAt = new Date(Date.now() + readBookArtifactWriteLeaseMs());
    return this.prisma.$transaction(async (tx) => {
      // FOR SHARE conflicts with the tombstoning UPDATE in hard-deletion
      // request(): admission waits for an in-flight tombstone, then re-evaluates
      // `deleted_at IS NULL` against the committed row.
      const live = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM books WHERE id = ${bookId}::uuid AND deleted_at IS NULL FOR SHARE`;
      if (live.length === 0) throw new BookArtifactWritesClosedError();
      const intent = await tx.bookArtifactWriteIntent.create({
        data: {
          bookId,
          kind,
          artifacts: artifacts as unknown as Prisma.InputJsonValue,
          leaseExpiresAt,
        },
      });
      return { id: intent.id, bookId };
    });
  }

  /** Consumes the intent inside the caller's publication transaction. */
  async releaseInTransaction(
    tx: Prisma.TransactionClient,
    intent: BookArtifactWriteHandle,
  ): Promise<void> {
    const consumed = await tx.bookArtifactWriteIntent.deleteMany({
      where: { id: intent.id, state: BookArtifactWriteState.active },
    });
    if (consumed.count !== 1) throw new BookArtifactWriteFencedError();
  }

  /**
   * For writers whose artifact is its own publication (a derived cache). If the
   * intent was fenced meanwhile, the artifact is treated as unpublished.
   */
  async release(intent: BookArtifactWriteHandle): Promise<void> {
    try {
      await this.prisma.$transaction((tx) => this.releaseInTransaction(tx, intent));
    } catch (err) {
      if (err instanceof BookArtifactWriteFencedError) {
        await this.discard(intent);
        return;
      }
      throw err;
    }
  }

  /**
   * The writer did not publish. Never throws: the durable `cleanup_pending`
   * record, not this call, is what guarantees eventual cleanup. If the record is
   * already gone, the intent was consumed by a committed publication (or fully
   * cleaned) and nothing is deleted — this is what keeps an ambiguous commit
   * acknowledgement from deleting a published artifact.
   */
  async discard(intent: BookArtifactWriteHandle): Promise<void> {
    try {
      await this.prisma.bookArtifactWriteIntent.updateMany({
        where: { id: intent.id, state: BookArtifactWriteState.active },
        data: { state: BookArtifactWriteState.cleanup_pending },
      });
      const row = await this.prisma.bookArtifactWriteIntent.findUnique({
        where: { id: intent.id },
      });
      if (row) await this.cleanRow(row);
    } catch {
      this.logger.warn(
        `book_artifact_write_cleanup_deferred intentId=${intent.id} bookId=${intent.bookId}`,
      );
    }
  }

  /**
   * Fences every expired `active` intent into `cleanup_pending`, then retries
   * all pending cleanups. Safe to run concurrently and repeatedly: every step is
   * idempotent and only ever removes artifacts that were never published.
   */
  async recoverStale(
    options: { bookId?: string; limit?: number; now?: Date } = {},
  ): Promise<BookArtifactRecoverySummary> {
    const now = options.now ?? new Date();
    const scope = options.bookId ? { bookId: options.bookId } : {};
    await this.prisma.bookArtifactWriteIntent.updateMany({
      where: { ...scope, state: BookArtifactWriteState.active, leaseExpiresAt: { lte: now } },
      data: { state: BookArtifactWriteState.cleanup_pending },
    });
    const rows = await this.prisma.bookArtifactWriteIntent.findMany({
      where: { ...scope, state: BookArtifactWriteState.cleanup_pending },
      orderBy: { updatedAt: 'asc' },
      take: options.limit ?? 25,
    });
    const summary: BookArtifactRecoverySummary = { cleaned: 0, failed: 0 };
    for (const row of rows) {
      try {
        await this.cleanRow(row);
        summary.cleaned += 1;
      } catch {
        summary.failed += 1;
        this.logger.warn(
          `book_artifact_write_cleanup_failed intentId=${row.id} bookId=${row.bookId}`,
        );
      }
    }
    return summary;
  }

  /**
   * Hard-deletion step 1. Fences expired writers and returns how many writers
   * may still be running. Because admission is closed by the tombstone, this
   * count can only fall: zero means no writer exists and none can appear.
   */
  async countBlockingWriters(bookId: string, now: Date = new Date()): Promise<number> {
    await this.prisma.bookArtifactWriteIntent.updateMany({
      where: { bookId, state: BookArtifactWriteState.active, leaseExpiresAt: { lte: now } },
      data: { state: BookArtifactWriteState.cleanup_pending },
    });
    return this.prisma.bookArtifactWriteIntent.count({
      where: { bookId, state: BookArtifactWriteState.active },
    });
  }

  /**
   * Hard-deletion final step, inside the finalization transaction and only after
   * the book-scoped sweep was freshly verified: drops the cleanup records the
   * sweep made redundant. Returns the number of writers still `active`, in which
   * case the caller must not complete.
   */
  async settleForDeletion(tx: Prisma.TransactionClient, bookId: string): Promise<number> {
    const active = await tx.bookArtifactWriteIntent.count({
      where: { bookId, state: BookArtifactWriteState.active },
    });
    if (active > 0) return active;
    await tx.bookArtifactWriteIntent.deleteMany({ where: { bookId } });
    return 0;
  }

  /** Deletes and then freshly verifies absence of every artifact, then removes the record. */
  private async cleanRow(row: BookArtifactWriteIntent): Promise<void> {
    for (const artifact of parseArtifacts(row.artifacts)) {
      if (artifact.store === 'image') {
        await this.imageStorage.deleteImageAsset(artifact.key);
        if (await this.imageStorage.getImageAsset(artifact.key)) {
          throw new Error('Artifact still present after delete');
        }
      } else {
        const namespace = claimNamespace(artifact.runId, artifact.fencingVersion);
        await this.pdfStorage.deleteClaimPreviewPdf(row.bookId, namespace);
        if (await this.pdfStorage.claimPreviewPdfExists(row.bookId, namespace)) {
          throw new Error('Artifact still present after delete');
        }
      }
    }
    await this.prisma.bookArtifactWriteIntent.deleteMany({
      where: { id: row.id, state: BookArtifactWriteState.cleanup_pending },
    });
  }
}
