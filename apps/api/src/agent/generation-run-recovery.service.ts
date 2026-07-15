import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { GenerationRunStatus, type GenerationRun } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { GenerationQueueService } from './generation-queue.service';
import { GenerationRunCoordinator } from './generation-run-coordinator.service';
import { GENERATION_INTERRUPTED_MESSAGE } from './generation-job-recovery.service';

export const DEFAULT_GENERATION_RUN_QUEUED_STALE_MS = 5 * 60 * 1000;
export const DEFAULT_GENERATION_RUN_RECOVERY_INTERVAL_MS = 60 * 1000;
export const DEFAULT_RECOVERY_LEASE_MS = 5 * 60 * 1000;

/**
 * Fixed singleton row id every live instance contends over to elect one
 * recovery leader per pass — seeded by the Phase A migration
 * (`INSERT ... ON CONFLICT DO NOTHING`) so there is no first-acquire race.
 * See RecoveryLease in schema.prisma.
 */
const RECOVERY_LEASE_ID = 'generation_run_recovery';

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

/** Reads RECOVERY_LEASE_MS from env, falling back to a safe default when missing or malformed. */
export function readRecoveryLeaseMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['RECOVERY_LEASE_MS'];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RECOVERY_LEASE_MS;
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
 * Leadership is elected via a single-row RecoveryLease (a plain conditional
 * UPDATE, correct under connection pooling) rather than a Postgres
 * session-scoped advisory lock — pg_try_advisory_lock/pg_advisory_unlock
 * require acquire/work/release to run on the same physical connection, a
 * guarantee Prisma's pooled client does not make; getting that wrong either
 * leaks the lock (permanently wedging future passes) or gives no real
 * cross-instance guarantee at all. The actual run/Book terminal write for
 * each stale candidate goes through GenerationRunCoordinator.failAbandoned —
 * the same fenced (`status` + `fencingVersion` in the WHERE clause, run/Book
 * transitioned in one transaction) mechanism BooksService's exhausted-retries
 * backstop uses — so a run a live worker legitimately advanced between this
 * pass's SELECT and its write is left untouched, not just here but by
 * construction, in one place.
 */
@Injectable()
export class GenerationRunRecoveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(GenerationRunRecoveryService.name);
  private readonly instanceId = randomUUID();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly generationQueueService: GenerationQueueService,
    private readonly generationRunCoordinator: GenerationRunCoordinator,
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

  /**
   * Acquires the RecoveryLease for this instance, using PostgreSQL's own
   * server time (`NOW()`) for both the expiry comparison and the new
   * expiry's computation — never application `Date`, which would let clock
   * skew between instances (or between an instance and the DB) cause two
   * instances to disagree about whether a lease has actually expired. A
   * plain conditional row UPDATE, so it's safe regardless of which pooled
   * connection executes it.
   *
   * `lease_generation` is incremented on every successful acquire (never on
   * a mere renewal — there is no renewal path; a lease is held for exactly
   * one pass) and returned to the caller as a fencing token: a former leader
   * whose lease has since expired and been acquired by a new leader can
   * detect via stillHoldsLease that its generation is stale and must stop
   * issuing further recovery writes, even before its own wall-clock check
   * would catch up.
   */
  private async acquireLease(leaseMs: number): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<Array<{ lease_generation: number }>>`
      UPDATE recovery_leases
      SET lease_owner = ${this.instanceId},
          lease_expires_at = NOW() + (${leaseMs}::text || ' milliseconds')::interval,
          lease_generation = lease_generation + 1
      WHERE id = ${RECOVERY_LEASE_ID}
        AND (lease_owner IS NULL OR lease_expires_at < NOW())
      RETURNING lease_generation
    `;
    return rows[0]?.lease_generation ?? null;
  }

  /**
   * Cheap fencing check the recovery loop re-verifies between candidates: a
   * bounded-batch guard so a pass can never keep issuing recovery writes past
   * its own lease, whether because it simply ran long (wall-clock — caught by
   * the lease itself expiring and a new leader's acquire bumping the
   * generation) or because a new leader already took over. Returns false
   * — never throws — the instant this instance no longer holds the exact
   * generation it acquired.
   */
  private async stillHoldsLease(generation: number): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok FROM recovery_leases
      WHERE id = ${RECOVERY_LEASE_ID}
        AND lease_owner = ${this.instanceId}
        AND lease_generation = ${generation}
        AND lease_expires_at > NOW()
    `;
    return rows.length > 0;
  }

  /** Best-effort release, fenced on still holding the exact generation acquired — not required for correctness (the lease has a TTL), just lets the next interval tick elsewhere sooner. Never releases a lease a newer leader has since acquired. */
  private async releaseLease(generation: number): Promise<void> {
    await this.prisma.recoveryLease.updateMany({
      where: { id: RECOVERY_LEASE_ID, leaseOwner: this.instanceId, leaseGeneration: generation },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
  }

  async recover(now: Date = new Date()): Promise<RunRecoverySummary> {
    const generation = await this.acquireLease(readRecoveryLeaseMs());
    if (generation === null) {
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
      let processed = 0;
      for (const run of candidates) {
        // Bounded-batch guard (in place of a renewal heartbeat): re-verify
        // leadership before every write so this pass's total duration can
        // never exceed its own lease, and a former leader superseded by a
        // new one stops immediately rather than continuing to issue writes.
        if (!(await this.stillHoldsLease(generation))) {
          this.logger.warn(
            `Generation run recovery lost leadership (generation ${generation}) after processing ${processed}/${candidates.length} candidates this pass — stopping early; the remaining candidates are picked up next pass.`,
          );
          break;
        }
        processed += 1;
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

      return {
        staleFound: candidates.length,
        recovered,
        stillPendingInBullMq,
        errors,
        lockSkipped: false,
      };
    } finally {
      await this.releaseLease(generation);
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

    // `fromStatus: run.status` (not a hardcoded `running`) because a
    // candidate here can be a never-claimed `queued` run stuck in dispatch,
    // not just a claimed-then-abandoned `running` one — see this class's own
    // doc comment. A 'stale_fence' result means something else (a live
    // claim, a normal completion) already moved this run on between our
    // SELECT and the coordinator's write — not an error, just a lost race,
    // and Book is provably left untouched by that same transaction.
    const result = await this.generationRunCoordinator.failAbandoned(
      {
        runId: run.id,
        bookId: run.bookId,
        fencingVersion: run.fencingVersion,
        // Safe: `run` only ever comes from this pass's staleRunning/staleQueued
        // queries (see recover()), which already filter to exactly these two
        // statuses — the wider GenerationRunStatus type here is just Prisma's
        // model type, not a claim that 'completed'/'failed' are possible.
        fromStatus: run.status as
          typeof GenerationRunStatus.queued | typeof GenerationRunStatus.running,
      },
      { errorCode: ABANDONED_ERROR_CODE, errorMessage: GENERATION_INTERRUPTED_MESSAGE },
    );

    return result === 'applied' ? 'recovered' : 'still-pending';
  }
}
