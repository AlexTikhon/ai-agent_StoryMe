import { Injectable } from '@nestjs/common';
import { GenerationRunStatus, type GenerationRun } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

/** Generous default — real (paid) image generation can run for several minutes; a run's lease must comfortably outlive one full pipeline attempt so a slow-but-alive worker is never mistaken for abandoned. */
export const DEFAULT_GENERATION_RUN_LEASE_MS = 30 * 60 * 1000;

/** Reads GENERATION_RUN_LEASE_MS from env, falling back to a safe default when missing or malformed. */
export function readGenerationRunLeaseMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['GENERATION_RUN_LEASE_MS'];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_GENERATION_RUN_LEASE_MS;
}

/**
 * Worker-facing lifecycle operations on GenerationRun — claim/complete/fail,
 * all guarded so a stale worker (recovery already reclaimed/failed the run,
 * or a newer run superseded it) can never overwrite a run or Book it no
 * longer owns. Run *creation* lives in BooksService instead, since it must
 * happen inside the same DB transaction as the Book status transition and
 * OutboxEvent write (see BooksService.createRunAndSchedule) — this service
 * only owns the parts of the lifecycle that happen after that transaction
 * commits.
 */
@Injectable()
export class GenerationRunService {
  constructor(private readonly prisma: PrismaService) {}

  /** The book's currently active (queued/running) run, if any — mirrors GenerationJobService.findActive's role for the new aggregate. */
  findActiveForBook(bookId: string): Promise<GenerationRun | null> {
    return this.prisma.generationRun.findFirst({
      where: { bookId, status: { in: [GenerationRunStatus.queued, GenerationRunStatus.running] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** The book's most recent run of any status — used by BooksService.retryGeneration to copy the failed run's exact inputSnapshot (see Phase 2D retry/regenerate split). */
  findLatestForBook(bookId: string): Promise<GenerationRun | null> {
    return this.prisma.generationRun.findFirst({
      where: { bookId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Number of runs currently queued/running for `userId`, across every one of their books — the authoritative source for the per-user concurrent-generation cap (BooksService.assertGenerationAllowed). */
  countActiveForUser(userId: string): Promise<number> {
    return this.prisma.generationRun.count({
      where: { userId, status: { in: [GenerationRunStatus.queued, GenerationRunStatus.running] } },
    });
  }

  /** Number of runs created for `userId` since `since` — the authoritative source for the per-user rolling-window generation cap. */
  countCreatedForUserSince(userId: string, since: Date): Promise<number> {
    return this.prisma.generationRun.count({
      where: { userId, createdAt: { gte: since } },
    });
  }

  /**
   * Atomically claims `runId` for `workerId`'s `jobAttempt` (BullMQ's
   * `job.attemptsMade + 1`): succeeds only if the run is still
   * queued/running AND at least one of:
   *   - unleased (never claimed);
   *   - already leased to this same worker (a BullMQ retry re-invoking the
   *     same still-live process);
   *   - its lease has wall-clock expired (an abandoned run — recovery would
   *     otherwise need to reclaim it instead);
   *   - `jobAttempt` is strictly greater than the attempt currently holding
   *     the lease — BullMQ only ever issues attempt N+1 after it has itself
   *     decided attempt N is done or stalled, so a strictly-higher attempt
   *     number is always safe to trust as "this delivery supersedes
   *     whatever is currently held," independent of whether the DB lease
   *     happens to have expired yet. Without this clause, a legitimate
   *     redelivery to a *different* worker before the old lease's wall-clock
   *     expiry would fail to claim and be silently treated as a no-op —
   *     the run would never actually run again (see GenerationQueueProcessor).
   * Returns null — never throws — when the claim doesn't match any row, so
   * callers can treat "someone/something else already owns this run, or it's
   * already terminal" as a normal no-op rather than an error.
   */
  async claim(
    runId: string,
    workerId: string,
    leaseMs: number,
    jobAttempt: number,
  ): Promise<GenerationRun | null> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const result = await this.prisma.generationRun.updateMany({
      where: {
        id: runId,
        status: { in: [GenerationRunStatus.queued, GenerationRunStatus.running] },
        OR: [
          { leaseOwner: null },
          { leaseOwner: workerId },
          { leaseExpiresAt: { lt: now } },
          { leaseAttempt: { lt: jobAttempt } },
        ],
      },
      data: {
        status: GenerationRunStatus.running,
        leaseOwner: workerId,
        leaseExpiresAt,
        leaseAttempt: jobAttempt,
        // Overwritten on every (re-)claim, including a same-worker retry —
        // this loses the true original start time across a retry, a cosmetic
        // inaccuracy only; not worth a conditional-write round trip to avoid.
        startedAt: now,
        fencingVersion: { increment: 1 },
      },
    });
    if (result.count === 0) return null;
    return this.prisma.generationRun.findUnique({ where: { id: runId } });
  }

  /**
   * Extends `runId`'s lease without changing anything else — called
   * periodically by GenerationQueueProcessor while it still holds a claim, so
   * a slow-but-genuinely-alive worker's lease never wall-clock-expires out
   * from under it (which would let recovery or a stale-redelivery claim
   * incorrectly treat it as abandoned). Fenced on `fencingVersion` and
   * `leaseOwner` — a heartbeat from an attempt already superseded by a newer
   * claim is a safe no-op, not an error.
   */
  async heartbeat(
    runId: string,
    workerId: string,
    fencingVersion: number,
    leaseMs: number,
  ): Promise<boolean> {
    const result = await this.prisma.generationRun.updateMany({
      where: {
        id: runId,
        status: GenerationRunStatus.running,
        leaseOwner: workerId,
        fencingVersion,
      },
      data: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
    });
    return result.count > 0;
  }
}
