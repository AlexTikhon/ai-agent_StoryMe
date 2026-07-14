import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { BookStatus, GenerationRunStatus, type GenerationRun } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { GenerationQueueService } from './generation-queue.service';
import { GENERATION_INTERRUPTED_MESSAGE } from './generation-job-recovery.service';

export const DEFAULT_GENERATION_RUN_QUEUED_STALE_MS = 5 * 60 * 1000;
export const DEFAULT_GENERATION_RUN_RECOVERY_INTERVAL_MS = 60 * 1000;

/**
 * Fixed key for a Postgres advisory lock (pg_try_advisory_lock takes a
 * bigint) — must stay stable and must not collide with any other
 * pg_advisory_lock user in this database. Scopes recovery to one live
 * instance at a time across every API/worker process, without any new
 * infrastructure dependency (Postgres is already required).
 */
const RECOVERY_ADVISORY_LOCK_KEY = 782_340_01;

/** States BullMQ can report where the job is genuinely gone/exhausted, not merely momentarily quiet. */
const ABANDONED_ERROR_CODE = 'GENERATION_ABANDONED';

export interface RunRecoverySummary {
  staleFound: number;
  recovered: number;
  stillPendingInBullMq: number;
  errors: number;
  lockSkipped: boolean;
}

/** Reads GENERATION_RUN_QUEUED_STALE_MS from env, falling back to a safe default when missing or malformed. */
export function readGenerationRunQueuedStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['GENERATION_RUN_QUEUED_STALE_MS'];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_GENERATION_RUN_QUEUED_STALE_MS;
}

/** Reads GENERATION_RUN_RECOVERY_INTERVAL_MS from env, falling back to a safe default when missing or malformed. */
export function readGenerationRunRecoveryIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['GENERATION_RUN_RECOVERY_INTERVAL_MS'];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_GENERATION_RUN_RECOVERY_INTERVAL_MS;
}

/**
 * Reconciles GenerationRun rows abandoned by a process that died or
 * restarted mid-run, WITHOUT the flaw the old age-only
 * GenerationJobRecoveryService had (see that service's own doc comment,
 * scoped down in this same phase to never touch Book anymore): a `running`
 * run's lease expiring is only ever a *candidate* for recovery — before
 * failing it, this checks BullMQ's own state for that run's job
 * (GenerationQueueService.isJobStillPending). A job BullMQ still considers
 * active/waiting/delayed/retriable is left alone, even past its DB lease —
 * the lease is a bookkeeping heuristic, not a substitute for the queue's own
 * truth (invariant F in docs/local-generation-pipeline.md).
 *
 * A `queued` run is a separate case: nothing has ever heartbeated/leased it
 * (lease fields are only set at claim time), so its own staleness signal is
 * simply "created too long ago" (GENERATION_RUN_QUEUED_STALE_MS) — normally
 * caught almost immediately by OutboxDispatcherService, so a `queued` run
 * surviving past this window means dispatch itself is stuck, not that a
 * worker died mid-run.
 *
 * Runs behind a Postgres advisory lock (pg_try_advisory_lock) so only one
 * live API/worker instance executes a recovery pass at a time — no new
 * infrastructure dependency, Postgres is already required. Every write is a
 * fenced conditional update (`status` + `fencingVersion` in the WHERE
 * clause) so a run a live worker legitimately advanced between this pass's
 * SELECT and its UPDATE is left untouched (0 rows matched, not an error).
 */
@Injectable()
export class GenerationRunRecoveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(GenerationRunRecoveryService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly generationQueueService: GenerationQueueService,
  ) {}

  /** Never throws — a recovery failure is logged and the app still boots/keeps running. */
  async onApplicationBootstrap(): Promise<void> {
    await this.runPass();
    const intervalMs = readGenerationRunRecoveryIntervalMs();
    this.timer = setInterval(() => {
      this.runPass().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Generation run recovery pass failed unexpectedly: ${message}`);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async runPass(): Promise<void> {
    try {
      const summary = await this.recover();
      if (summary.lockSkipped) return;
      this.logger.log(
        `Generation run recovery: found ${summary.staleFound} stale candidate(s), ` +
          `recovered ${summary.recovered}, ${summary.stillPendingInBullMq} still pending in BullMQ (left alone), ${summary.errors} error(s)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Generation run recovery failed to run: ${message}`);
    }
  }

  async recover(now: Date = new Date()): Promise<RunRecoverySummary> {
    const lockRows = await this.prisma.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${RECOVERY_ADVISORY_LOCK_KEY}) AS locked
    `;
    if (!lockRows[0]?.locked) {
      return { staleFound: 0, recovered: 0, stillPendingInBullMq: 0, errors: 0, lockSkipped: true };
    }

    try {
      const queuedCutoff = new Date(now.getTime() - readGenerationRunQueuedStaleMs());
      const [staleRunning, staleQueued] = await Promise.all([
        this.prisma.generationRun.findMany({
          where: { status: GenerationRunStatus.running, leaseExpiresAt: { lt: now } },
        }),
        this.prisma.generationRun.findMany({
          where: { status: GenerationRunStatus.queued, createdAt: { lt: queuedCutoff } },
        }),
      ]);
      const candidates = [...staleRunning, ...staleQueued];

      let recovered = 0;
      let stillPendingInBullMq = 0;
      let errors = 0;
      for (const run of candidates) {
        try {
          const outcome = await this.recoverOne(run);
          if (outcome === 'recovered') recovered += 1;
          else stillPendingInBullMq += 1;
        } catch (err) {
          errors += 1;
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`Failed to recover generation run ${run.id}: ${message}`);
        }
      }

      return { staleFound: candidates.length, recovered, stillPendingInBullMq, errors, lockSkipped: false };
    } finally {
      await this.prisma.$queryRaw`SELECT pg_advisory_unlock(${RECOVERY_ADVISORY_LOCK_KEY})`;
    }
  }

  private async recoverOne(run: GenerationRun): Promise<'recovered' | 'still-pending'> {
    const stillPending = await this.generationQueueService.isJobStillPending(run.id);
    if (stillPending) {
      this.logger.log(
        `Run ${run.id} (book ${run.bookId}) looks stale by DB lease/age but BullMQ still has its job pending — leaving it alone this pass.`,
      );
      return 'still-pending';
    }

    const updated = await this.prisma.generationRun.updateMany({
      where: { id: run.id, status: run.status, fencingVersion: run.fencingVersion },
      data: {
        status: GenerationRunStatus.failed,
        failedAt: new Date(),
        errorCode: ABANDONED_ERROR_CODE,
        errorMessage: GENERATION_INTERRUPTED_MESSAGE,
      },
    });
    if (updated.count === 0) {
      // Something else (a live claim, a normal completion) already moved this
      // run on between our SELECT and this UPDATE — not an error, just a lost race.
      return 'still-pending';
    }

    await this.prisma.book.updateMany({
      where: { id: run.bookId, activeRunId: run.id },
      data: {
        activeRunId: null,
        status: BookStatus.failed,
        failedStep: null,
        errorMessage: GENERATION_INTERRUPTED_MESSAGE,
      },
    });
    return 'recovered';
  }
}
