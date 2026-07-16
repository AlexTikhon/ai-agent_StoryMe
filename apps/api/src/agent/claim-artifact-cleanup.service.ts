import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Book } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { IMAGE_ASSET_STORAGE_TOKEN, type ImageAssetStorage } from '../images/image-asset-storage';
import { PDF_STORAGE_TOKEN, type PdfStorage } from '../pdf/pdf-storage';
import {
  claimArtifactNamespaceGroupKey,
  parseClaimArtifactStorageKey,
  type ClaimArtifactListPage,
  type ClaimArtifactStorageEntry,
} from './claim-artifact-key';
import { readRecoveryLeaseMs } from './generation-run-recovery.service';

/**
 * Phase C — Orphaned Claim-Artifact Cleanup.
 *
 * A storage-listing sweeper, not a database-driven one: there is no
 * GenerationArtifact/ArtifactNamespace model recording which claim
 * namespaces exist. Instead, every pass lists whatever raw claim-scoped keys
 * currently sit in ImageAssetStorage/PdfStorage, groups them into exact
 * (bookId, runId, fencingVersion) namespaces via parseClaimArtifactStorageKey,
 * and asks the DB whether each namespace is still referenced — never the
 * other way around. This means a namespace this process has never heard of
 * (e.g. one from before this service existed) is still correctly discovered
 * and classified, since discovery starts from storage, not from a run
 * history.
 *
 * A namespace is protected (never deleted) when ANY of:
 *   - it is the exact published namespace (Book.publishedRunId +
 *     publishedRunFencingVersion);
 *   - it is the exact resumable namespace (Book.lastGenerationRunId +
 *     lastGenerationFencingVersion);
 *   - its runId equals Book.activeRunId (every fencingVersion under that run
 *     is protected, not just the current one — a stalled redelivery can
 *     leave an older fencingVersion's artifacts as the last complete set
 *     copy-forward would need);
 *   - it is younger than CLAIM_CLEANUP_RETENTION_MS, using the storage
 *     driver's own reported lastModified — never GenerationRun.createdAt,
 *     since there is no per-namespace DB row at all.
 *
 * Deliberately never infers protection from Book.status, the latest
 * GenerationRun, BullMQ state, or filename guesses — only these four exact,
 * literal checks. If the Book row can't be read at all (DB error), or the
 * namespace's age can't be determined, the namespace is left alone — a
 * failed protection check always fails closed, never open.
 *
 * Leadership is elected via the same single-row RecoveryLease mechanism
 * GenerationRunRecoveryService uses (see that service's own doc comment for
 * why a plain conditional UPDATE is used instead of a Postgres advisory
 * lock), under its own dedicated lease id so the two sweeps never contend
 * with each other.
 */
export const DEFAULT_CLAIM_CLEANUP_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CLAIM_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
export const DEFAULT_CLAIM_CLEANUP_LEASE_MS = 10 * 60 * 1000;
export const DEFAULT_CLAIM_CLEANUP_PAGE_SIZE = 500;
export const DEFAULT_CLAIM_CLEANUP_MAX_NAMESPACES_PER_PASS = 200;
export const DEFAULT_CLAIM_CLEANUP_MAX_OBJECTS_PER_PASS = 10_000;
export const DEFAULT_CLAIM_CLEANUP_DELETE_CONCURRENCY = 5;

const CLEANUP_LEASE_ID = 'claim_artifact_cleanup';

export function readClaimCleanupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['CLAIM_CLEANUP_ENABLED'] === 'true';
}

/** Defaults to true (the safe posture) — an operator must explicitly opt out of dry-run to let this service delete anything. */
export function readClaimCleanupDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['CLAIM_CLEANUP_DRY_RUN'] !== 'false';
}

function readPositiveInt(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function readClaimCleanupRetentionMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt('CLAIM_CLEANUP_RETENTION_MS', DEFAULT_CLAIM_CLEANUP_RETENTION_MS, env);
}

export function readClaimCleanupIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt('CLAIM_CLEANUP_INTERVAL_MS', DEFAULT_CLAIM_CLEANUP_INTERVAL_MS, env);
}

export function readClaimCleanupLeaseMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt('CLAIM_CLEANUP_LEASE_MS', DEFAULT_CLAIM_CLEANUP_LEASE_MS, env);
}

export function readClaimCleanupPageSize(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt('CLAIM_CLEANUP_PAGE_SIZE', DEFAULT_CLAIM_CLEANUP_PAGE_SIZE, env);
}

export function readClaimCleanupMaxNamespacesPerPass(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(
    'CLAIM_CLEANUP_MAX_NAMESPACES_PER_PASS',
    DEFAULT_CLAIM_CLEANUP_MAX_NAMESPACES_PER_PASS,
    env,
  );
}

export function readClaimCleanupMaxObjectsPerPass(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(
    'CLAIM_CLEANUP_MAX_OBJECTS_PER_PASS',
    DEFAULT_CLAIM_CLEANUP_MAX_OBJECTS_PER_PASS,
    env,
  );
}

export function readClaimCleanupDeleteConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(
    'CLAIM_CLEANUP_DELETE_CONCURRENCY',
    DEFAULT_CLAIM_CLEANUP_DELETE_CONCURRENCY,
    env,
  );
}

/**
 * A namespace is only ever retention-protected by its own storage-reported
 * age, never by a fresh DB read of the run that wrote it — so
 * CLAIM_CLEANUP_RETENTION_MS must comfortably outlast the window in which a
 * live-but-momentarily-stale worker (GC pause, network blip) could still be
 * writing to a namespace whose Book pointers a recovery pass hasn't caught up
 * with yet. That window is bounded by RECOVERY_LEASE_MS (how long a run's own
 * lease/heartbeat can go unrenewed before GenerationRunRecoveryService even
 * considers it a candidate for failure) — this asserts retention is at least
 * MIN_RETENTION_TO_LEASE_RATIO times that, and refuses to let the service
 * schedule any work at all otherwise. Mirrors assertPdfStorageSupportsWorker's
 * fail-fast-at-boot posture (pdf-storage.ts) rather than a runtime warning.
 */
const MIN_RETENTION_TO_LEASE_RATIO = 10;

export function assertClaimCleanupRetentionSafety(env: NodeJS.ProcessEnv = process.env): void {
  const retentionMs = readClaimCleanupRetentionMs(env);
  const recoveryLeaseMs = readRecoveryLeaseMs(env);
  const minRequired = recoveryLeaseMs * MIN_RETENTION_TO_LEASE_RATIO;
  if (retentionMs < minRequired) {
    throw new Error(
      `CLAIM_CLEANUP_RETENTION_MS (${retentionMs}) must be at least ${MIN_RETENTION_TO_LEASE_RATIO}x ` +
        `RECOVERY_LEASE_MS (${recoveryLeaseMs} → minimum ${minRequired}) — otherwise a namespace a live ` +
        `worker is still writing to, whose Book pointers a recovery pass hasn't caught up with yet, could ` +
        `look "old enough" to delete. Increase CLAIM_CLEANUP_RETENTION_MS or decrease RECOVERY_LEASE_MS.`,
    );
  }
}

interface NamespaceGroup {
  bookId: string;
  runId: string;
  fencingVersion: number;
  /** Raw keys from both drivers backing this exact namespace, tagged by which driver must delete them. */
  imageKeys: string[];
  pdfKeys: string[];
  /** Most recent lastModified across every object in this namespace — undefined if the driver never reported one for any of them, which fails the retention check closed (see isYoungerThanRetention). */
  latestModified: Date | undefined;
}

/** Why classifyProtection found a namespace protected — never returned for an eligible namespace (that's `null`, see classifyProtection). */
export type ProtectionReason =
  | 'protected_published'
  | 'protected_resumable'
  | 'protected_active_run'
  | 'protected_retention';

export interface ClaimCleanupSummary {
  ranAsLeader: boolean;
  dryRun: boolean;
  discoveredObjects: number;
  malformedObjects: number;
  namespacesConsidered: number;
  protectedPublished: number;
  protectedResumable: number;
  protectedActiveRun: number;
  protectedRetention: number;
  protectedRevalidated: number;
  deletedNamespaces: number;
  dryRunEligibleNamespaces: number;
  partialFailureNamespaces: number;
  skippedDbErrorNamespaces: number;
  /** True when this pass hit CLAIM_CLEANUP_MAX_OBJECTS_PER_PASS or CLAIM_CLEANUP_MAX_NAMESPACES_PER_PASS and stopped early — the remainder is picked up on a later pass. */
  truncated: boolean;
}

type BookProtectionFields = Pick<
  Book,
  | 'id'
  | 'activeRunId'
  | 'publishedRunId'
  | 'publishedRunFencingVersion'
  | 'lastGenerationRunId'
  | 'lastGenerationFencingVersion'
>;

@Injectable()
export class ClaimArtifactCleanupService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ClaimArtifactCleanupService.name);
  private readonly instanceId = randomUUID();
  private timer: NodeJS.Timeout | undefined;
  /** Guards against an overlapping tick within this same process — a slow pass must never run concurrently with the next interval firing. */
  private runningPass = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(IMAGE_ASSET_STORAGE_TOKEN) private readonly imageAssetStorage: ImageAssetStorage,
    @Inject(PDF_STORAGE_TOKEN) private readonly pdfStorage: PdfStorage,
  ) {}

  /** Never throws — a cleanup failure is logged and the app still boots/keeps running. Disabled mode performs no work at all (not even the once-on-bootstrap pass), including no lease acquisition. */
  async onApplicationBootstrap(): Promise<void> {
    if (!readClaimCleanupEnabled()) {
      this.logger.log('Claim artifact cleanup disabled (CLAIM_CLEANUP_ENABLED is not "true") — skipping.');
      return;
    }
    assertClaimCleanupRetentionSafety();
    await this.runPass();
    const intervalMs = readClaimCleanupIntervalMs();
    this.timer = setInterval(() => {
      this.runPass().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Claim artifact cleanup pass failed unexpectedly: ${message}`);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async runPass(): Promise<void> {
    if (this.runningPass) {
      this.logger.warn('Claim artifact cleanup pass skipped — a previous pass in this process is still running.');
      return;
    }
    this.runningPass = true;
    try {
      const summary = await this.sweep();
      if (!summary.ranAsLeader) {
        this.logger.log('Claim artifact cleanup pass skipped — lease held by another instance.');
        return;
      }
      this.logger.log(
        `Claim artifact cleanup (dryRun=${summary.dryRun}): discovered ${summary.discoveredObjects} object(s), ` +
          `${summary.malformedObjects} malformed/skipped, ${summary.namespacesConsidered} namespace(s) considered — ` +
          `protected: ${summary.protectedPublished} published, ${summary.protectedResumable} resumable, ` +
          `${summary.protectedActiveRun} active-run, ${summary.protectedRetention} within retention, ` +
          `${summary.protectedRevalidated} revalidated at delete time; ` +
          `${summary.deletedNamespaces} deleted, ${summary.dryRunEligibleNamespaces} dry-run eligible, ` +
          `${summary.partialFailureNamespaces} partial failure(s), ${summary.skippedDbErrorNamespaces} skipped (DB error)` +
          (summary.truncated ? ' — pass truncated at its per-pass limit, remainder picked up next pass' : ''),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Claim artifact cleanup failed to run: ${message}`);
    } finally {
      this.runningPass = false;
    }
  }

  /** Same fencing-token lease mechanism as GenerationRunRecoveryService.acquireLease, under its own dedicated lease id (CLEANUP_LEASE_ID) so the two sweeps never contend with each other. */
  private async acquireLease(leaseMs: number): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<Array<{ lease_generation: number }>>`
      UPDATE recovery_leases
      SET lease_owner = ${this.instanceId},
          lease_expires_at = NOW() + (${leaseMs}::text || ' milliseconds')::interval,
          lease_generation = lease_generation + 1
      WHERE id = ${CLEANUP_LEASE_ID}
        AND (lease_owner IS NULL OR lease_expires_at < NOW())
      RETURNING lease_generation
    `;
    return rows[0]?.lease_generation ?? null;
  }

  private async stillHoldsLease(generation: number): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok FROM recovery_leases
      WHERE id = ${CLEANUP_LEASE_ID}
        AND lease_owner = ${this.instanceId}
        AND lease_generation = ${generation}
        AND lease_expires_at > NOW()
    `;
    return rows.length > 0;
  }

  private async releaseLease(generation: number): Promise<void> {
    await this.prisma.recoveryLease.updateMany({
      where: { id: CLEANUP_LEASE_ID, leaseOwner: this.instanceId, leaseGeneration: generation },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
  }

  async sweep(now: Date = new Date()): Promise<ClaimCleanupSummary> {
    const dryRun = readClaimCleanupDryRun();
    const emptySummary: ClaimCleanupSummary = {
      ranAsLeader: false,
      dryRun,
      discoveredObjects: 0,
      malformedObjects: 0,
      namespacesConsidered: 0,
      protectedPublished: 0,
      protectedResumable: 0,
      protectedActiveRun: 0,
      protectedRetention: 0,
      protectedRevalidated: 0,
      deletedNamespaces: 0,
      dryRunEligibleNamespaces: 0,
      partialFailureNamespaces: 0,
      skippedDbErrorNamespaces: 0,
      truncated: false,
    };

    const generation = await this.acquireLease(readClaimCleanupLeaseMs());
    if (generation === null) return emptySummary;

    try {
      return await this.sweepAsLeader(now, dryRun, generation);
    } finally {
      await this.releaseLease(generation);
    }
  }

  private async sweepAsLeader(now: Date, dryRun: boolean, generation: number): Promise<ClaimCleanupSummary> {
    const pageSize = readClaimCleanupPageSize();
    const maxObjects = readClaimCleanupMaxObjectsPerPass();
    const maxNamespaces = readClaimCleanupMaxNamespacesPerPass();
    const retentionMs = readClaimCleanupRetentionMs();

    const groups = new Map<string, NamespaceGroup>();
    let discoveredObjects = 0;
    let malformedObjects = 0;
    let truncated = false;

    const drivers: Array<{ storage: ImageAssetStorage | PdfStorage; field: 'imageKeys' | 'pdfKeys' }> = [
      { storage: this.imageAssetStorage, field: 'imageKeys' },
      { storage: this.pdfStorage, field: 'pdfKeys' },
    ];

    for (const { storage, field } of drivers) {
      let cursor: string | null = null;
      do {
        const page: ClaimArtifactListPage = await storage.listClaimArtifacts({ cursor, pageSize });
        for (const entry of page.entries) {
          if (discoveredObjects >= maxObjects) {
            truncated = true;
            break;
          }
          discoveredObjects += 1;
          this.classifyEntry(entry, field, groups, () => {
            malformedObjects += 1;
          });
        }
        cursor = page.nextCursor;
        if (discoveredObjects >= maxObjects) {
          truncated = true;
          break;
        }
      } while (cursor);
    }

    let namespaceEntries = Array.from(groups.values());
    if (namespaceEntries.length > maxNamespaces) {
      truncated = true;
      namespaceEntries = namespaceEntries.slice(0, maxNamespaces);
    }

    const bookIds = Array.from(new Set(namespaceEntries.map((g) => g.bookId)));
    let booksById: Map<string, BookProtectionFields>;
    let dbFailed = false;
    try {
      const books = await this.prisma.book.findMany({
        where: { id: { in: bookIds } },
        select: {
          id: true,
          activeRunId: true,
          publishedRunId: true,
          publishedRunFencingVersion: true,
          lastGenerationRunId: true,
          lastGenerationFencingVersion: true,
        },
      });
      booksById = new Map(books.map((b) => [b.id, b]));
    } catch (err) {
      dbFailed = true;
      booksById = new Map();
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Claim artifact cleanup: failed to read Book rows this pass — skipping all deletions: ${message}`);
    }

    const summary: ClaimCleanupSummary = {
      ranAsLeader: true,
      dryRun,
      discoveredObjects,
      malformedObjects,
      namespacesConsidered: namespaceEntries.length,
      protectedPublished: 0,
      protectedResumable: 0,
      protectedActiveRun: 0,
      protectedRetention: 0,
      protectedRevalidated: 0,
      deletedNamespaces: 0,
      dryRunEligibleNamespaces: 0,
      partialFailureNamespaces: 0,
      skippedDbErrorNamespaces: 0,
      truncated,
    };

    for (const group of namespaceEntries) {
      // Bounded-batch guard mirroring GenerationRunRecoveryService: re-verify
      // leadership before every namespace so a pass can never keep deleting
      // past its own lease — whether it simply ran long or a new leader
      // already took over. Skipped in dry-run, which never writes and so
      // can never corrupt anything by continuing past a lost lease.
      if (!dryRun && !dbFailed && !(await this.stillHoldsLease(generation))) {
        this.logger.warn(
          `Claim artifact cleanup lost leadership (generation ${generation}) mid-pass — stopping early; ` +
            `the remaining namespaces are picked up next pass.`,
        );
        summary.truncated = true;
        break;
      }

      if (dbFailed) {
        summary.skippedDbErrorNamespaces += 1;
        continue;
      }

      const book = booksById.get(group.bookId);
      const initialProtection = this.classifyProtection(group, book, now, retentionMs);
      if (initialProtection !== null) {
        this.tallyProtection(summary, initialProtection);
        continue;
      }

      if (dryRun) {
        summary.dryRunEligibleNamespaces += 1;
        continue;
      }

      // Re-check protection immediately before deletion, against a fresh DB
      // read (never the bulk snapshot above) — a run may have claimed this
      // exact namespace, or published/resumed it, in the time between this
      // pass's discovery and this specific delete.
      let freshBook: BookProtectionFields | null;
      try {
        freshBook = await this.prisma.book.findUnique({
          where: { id: group.bookId },
          select: {
            id: true,
            activeRunId: true,
            publishedRunId: true,
            publishedRunFencingVersion: true,
            lastGenerationRunId: true,
            lastGenerationFencingVersion: true,
          },
        });
      } catch (err) {
        summary.skippedDbErrorNamespaces += 1;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Claim artifact cleanup: revalidation DB read failed for book ${group.bookId} — skipping deletion: ${message}`,
        );
        continue;
      }

      const revalidated = this.classifyProtection(group, freshBook ?? undefined, now, retentionMs);
      if (revalidated !== null) {
        summary.protectedRevalidated += 1;
        continue;
      }

      const outcome = await this.deleteNamespace(group);
      if (outcome === 'deleted') {
        summary.deletedNamespaces += 1;
      } else {
        summary.partialFailureNamespaces += 1;
      }
    }

    return summary;
  }

  private classifyEntry(
    entry: ClaimArtifactStorageEntry,
    field: 'imageKeys' | 'pdfKeys',
    groups: Map<string, NamespaceGroup>,
    onMalformed: () => void,
  ): void {
    const parsed = parseClaimArtifactStorageKey(entry.key);
    if (!parsed) {
      onMalformed();
      return;
    }
    const groupKey = claimArtifactNamespaceGroupKey(parsed.bookId, parsed.runId, parsed.fencingVersion);
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        bookId: parsed.bookId,
        runId: parsed.runId,
        fencingVersion: parsed.fencingVersion,
        imageKeys: [],
        pdfKeys: [],
        latestModified: undefined,
      };
      groups.set(groupKey, group);
    }
    group[field].push(entry.key);
    if (entry.lastModified && (!group.latestModified || entry.lastModified > group.latestModified)) {
      group.latestModified = entry.lastModified;
    }
  }

  /** Returns the protection reason if protected, or null if eligible for cleanup. */
  private classifyProtection(
    group: NamespaceGroup,
    book: BookProtectionFields | null | undefined,
    now: Date,
    retentionMs: number,
  ): ProtectionReason | null {
    if (book) {
      if (book.publishedRunId === group.runId && book.publishedRunFencingVersion === group.fencingVersion) {
        return 'protected_published';
      }
      if (book.lastGenerationRunId === group.runId && book.lastGenerationFencingVersion === group.fencingVersion) {
        return 'protected_resumable';
      }
      if (book.activeRunId === group.runId) {
        return 'protected_active_run';
      }
    }

    if (this.isWithinRetention(group, now, retentionMs)) {
      return 'protected_retention';
    }

    return null;
  }

  /** Fails closed: a namespace whose age can't be determined (no driver ever reported a lastModified for any of its objects) is treated as within retention, never as eligible. */
  private isWithinRetention(group: NamespaceGroup, now: Date, retentionMs: number): boolean {
    if (!group.latestModified) return true;
    return now.getTime() - group.latestModified.getTime() < retentionMs;
  }

  private tallyProtection(summary: ClaimCleanupSummary, reason: ProtectionReason): void {
    switch (reason) {
      case 'protected_published':
        summary.protectedPublished += 1;
        break;
      case 'protected_resumable':
        summary.protectedResumable += 1;
        break;
      case 'protected_active_run':
        summary.protectedActiveRun += 1;
        break;
      case 'protected_retention':
        summary.protectedRetention += 1;
        break;
    }
  }

  /** Deletes every key in the namespace across both drivers, bounded by CLAIM_CLEANUP_DELETE_CONCURRENCY, and reports 'deleted' only when every single key succeeded — any failed/not_found-but-unexpected key marks the whole namespace 'partial_failure' so it's retried (only for its still-outstanding keys) on a later pass. */
  private async deleteNamespace(group: NamespaceGroup): Promise<'deleted' | 'partial_failure'> {
    const concurrency = readClaimCleanupDeleteConcurrency();

    const [imageOutcomes, pdfOutcomes] = await Promise.all([
      this.deleteInBatches(this.imageAssetStorage, group.imageKeys, concurrency),
      this.deleteInBatches(this.pdfStorage, group.pdfKeys, concurrency),
    ]);

    const allFailed = [...imageOutcomes, ...pdfOutcomes].filter((o) => o.outcome === 'failed');
    if (allFailed.length > 0) {
      this.logger.warn(
        `Claim artifact cleanup: namespace book=${group.bookId} run=${group.runId} fencing=${group.fencingVersion} ` +
          `had ${allFailed.length} failed deletion(s) — will retry on a later pass: ${allFailed
            .map((o) => `${o.key} (${o.error})`)
            .join('; ')}`,
      );
      return 'partial_failure';
    }
    return 'deleted';
  }

  /** Bounded-parallelism pool of single-key deletes — CLAIM_CLEANUP_DELETE_CONCURRENCY caps how many deleteClaimArtifacts calls for this namespace are ever in flight at once, across both local disk (a plain unlink per key) and cloud (each call its own DeleteObjectsCommand). */
  private async deleteInBatches(
    storage: ImageAssetStorage | PdfStorage,
    keys: string[],
    concurrency: number,
  ): Promise<Array<{ key: string; outcome: string; error?: string }>> {
    if (keys.length === 0) return [];
    const results: Array<{ key: string; outcome: string; error?: string }> = [];
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= keys.length) return;
        const outcomes = await storage.deleteClaimArtifacts([keys[index]!]);
        results.push(...outcomes);
      }
    };

    const workerCount = Math.max(1, Math.min(concurrency, keys.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }
}
