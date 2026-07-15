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
   * Atomically claims `runId` for this call's BullMQ delivery, identified by
   * `deliveryToken` — the `token` argument BullMQ's Worker passes to
   * GenerationQueueProcessor.process(job, token), a fresh value minted for
   * *every* lock acquisition, including a stalled-job redelivery to a
   * different worker (which BullMQ can issue without ever incrementing
   * job.attemptsMade — see this method's own history: an earlier version
   * fenced on `job.attemptsMade + 1`, which meant a legitimate
   * stalled-redelivery carrying the *same* attempt number as the delivery it
   * superseded could fail to claim and be silently dropped).
   *
   * Succeeds unconditionally whenever the run is still queued/running —
   * there is no OR-clause to satisfy, because a call to claim() only ever
   * happens when BullMQ itself is asserting "a worker holds this job's lock
   * right now." Every call unconditionally bumps `fencingVersion` and
   * overwrites `deliveryToken`/`leaseOwner`, so it always "replaces the
   * previous delivery owner" as its own action — the *previous* delivery
   * doesn't need to be identified or matched here at all. That previous
   * delivery's in-flight writes are instead fenced out downstream (see
   * heartbeat, GenerationExecutionService.applyFencedBookWrite,
   * GenerationRunCoordinator.completeRun), which all condition on the exact
   * fencingVersion this claim just set.
   *
   * Returns null — never throws — when the claim doesn't match any row (the
   * run is already terminal), so callers can treat that as a normal no-op
   * rather than an error.
   */
  async claim(
    runId: string,
    deliveryToken: string,
    workerId: string,
    leaseMs: number,
  ): Promise<GenerationRun | null> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const result = await this.prisma.generationRun.updateMany({
      where: {
        id: runId,
        status: { in: [GenerationRunStatus.queued, GenerationRunStatus.running] },
      },
      data: {
        status: GenerationRunStatus.running,
        leaseOwner: workerId,
        deliveryToken,
        leaseExpiresAt,
        // Overwritten on every (re-)claim, including a redelivery — this
        // loses the true original start time across a retry, a cosmetic
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
   * from under it (which would let recovery or a newer claim incorrectly
   * treat it as abandoned). Fenced on both `deliveryToken` *and*
   * `fencingVersion` — either one alone would already reject a heartbeat from
   * a delivery a newer claim has superseded, but checking both means a stale
   * delivery token can never heartbeat even in the (impossible in practice,
   * but never assumed) case fencingVersion wrapped or was somehow observed
   * stale. A heartbeat from a superseded attempt is a safe no-op, not an
   * error.
   */
  async heartbeat(
    runId: string,
    deliveryToken: string,
    fencingVersion: number,
    leaseMs: number,
  ): Promise<boolean> {
    const result = await this.prisma.generationRun.updateMany({
      where: {
        id: runId,
        status: GenerationRunStatus.running,
        deliveryToken,
        fencingVersion,
      },
      data: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
    });
    return result.count > 0;
  }
}
