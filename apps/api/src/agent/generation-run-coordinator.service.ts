import { Injectable, Logger } from '@nestjs/common';
import { BookStatus, GenerationRunStatus, type Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { GenerationOutcome } from './generation-outcome';
import { GENERATION_INPUT_SNAPSHOT_INVALID } from './generation-input-snapshot';

/** The subset of a claimed GenerationRun's identity every coordinator method needs — a full GenerationExecutionContext (which also carries the parsed inputSnapshot) satisfies this structurally, but failInvalidSnapshot/failAbandoned have no valid inputSnapshot to offer. */
export interface ClaimedRunRef {
  readonly runId: string;
  readonly bookId: string;
  readonly fencingVersion: number;
}

/** ClaimedRunRef plus the GenerationRun status a caller observed it in before deciding to fail it — completeRun/failInvalidSnapshot always fence from `running` (the only status a claimed, executing run can be in), but recovery can find a run stale while it's still `queued` (never claimed at all). */
export interface AbandonedRunRef extends ClaimedRunRef {
  readonly fromStatus: typeof GenerationRunStatus.queued | typeof GenerationRunStatus.running;
}

/**
 * Every coordinator method's result, distinguishing the three ways a fenced
 * terminal transition can end:
 *   - 'applied' — both the GenerationRun and Book writes matched and committed
 *     together; this attempt's outcome is now the durable, published state.
 *   - 'stale_fence' — the GenerationRun's own fencing WHERE clause matched
 *     zero rows: a newer claim or recovery pass already superseded this
 *     attempt before it got here. Expected under normal operation (races are
 *     inherent to the design, not a bug) — Book is provably untouched.
 *   - 'book_mirror_mismatch' — the GenerationRun fence matched (this attempt
 *     still legitimately owns the run), but Book.activeRunId no longer
 *     pointed back at it. Under every invariant this system maintains,
 *     Book.activeRunId is only ever cleared together with the very same
 *     run's own terminal transition, so this should never happen — if it
 *     does, it means the mirror invariant itself is broken (a bug, not a
 *     race), and the whole transaction (including the GenerationRun write)
 *     is rolled back rather than left half-applied. Logged at `error`
 *     severity, unlike the routine `stale_fence` case.
 *
 * A plain boolean cannot distinguish the last two cases — both are
 * "nothing happened" from a caller that only checks truthiness — so every
 * caller that needs to react differently (or simply must not silently claim
 * success) should switch on this instead of coercing it to boolean.
 */
export type CoordinatorOutcome = 'applied' | 'stale_fence' | 'book_mirror_mismatch';

/** Internal-only signal used to abort (and thus roll back) a transaction whose Book write matched zero rows despite its GenerationRun fence holding — see CoordinatorOutcome's 'book_mirror_mismatch' doc. Never escapes this file. */
class BookMirrorMismatchError extends Error {}

/**
 * Thrown by a caller that received a `'book_mirror_mismatch'`
 * CoordinatorOutcome and needs that fact to be a genuine, visible failure
 * rather than a quiet no-op — e.g. so BullMQ retries/fails the delivery
 * instead of treating it as completed. Every such caller must react
 * distinctly to this outcome (never fall through the same `!== 'applied'`
 * branch used for the routine `'stale_fence'` case); this error type exists
 * so "I saw a mirror mismatch and did something about it" is enforced by the
 * type checker at each call site, not just left to a comment.
 */
export class GenerationRunMirrorInvariantError extends Error {
  constructor(runId: string, bookId: string) {
    super(
      `GenerationRun ${runId} (book ${bookId}) hit a book_mirror_mismatch — the run/Book mirror invariant is broken. This delivery must not be treated as successfully completed.`,
    );
    this.name = 'GenerationRunMirrorInvariantError';
  }
}

/**
 * The single choke point that publishes a GenerationRun's terminal outcome —
 * extracted out of BooksService (not just kept as a private method there) so
 * this exact production code path, not a hand-copied mirror of it, can be
 * exercised directly against a real Postgres in integration tests without
 * constructing all of BooksService's other dependencies (pdf storage, image
 * storage, rate limiter, etc.) — see "Test the production completion/failure
 * method, not a copied implementation" in the Phase A.1 hardening report.
 *
 * Every public method here shares one shape: a fenced GenerationRun write,
 * and — only if that held — a Book mirror write, both inside one
 * transaction, via the private runFencedTerminalTransition helper. What
 * differs per caller (BullMQ retry exhaustion vs. abandoned-run recovery vs.
 * AgentService's own outcome vs. a permanently malformed input_snapshot) is
 * only *when* to fail a run and with what code/message — that policy stays
 * in BooksService/GenerationRunRecoveryService; only the transactional
 * write mechanism itself lives here, so this stays a small, typed API
 * rather than growing into a god service that also owns queue/recovery
 * orchestration.
 */
@Injectable()
export class GenerationRunCoordinator {
  private readonly logger = new Logger(GenerationRunCoordinator.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs one fenced GenerationRun write, then — only if it matched — one
   * Book mirror write, both inside a single transaction. See
   * CoordinatorOutcome's doc comment for what each result means. A
   * `book_mirror_mismatch` rolls the *entire* transaction back (the
   * GenerationRun write included), so that outcome never leaves GenerationRun
   * terminal while Book stays non-terminal — every commit that actually
   * happens is fully consistent between the two tables.
   */
  private async runFencedTerminalTransition(params: {
    runWhere: { id: string; status: GenerationRunStatus; fencingVersion: number };
    runData: Prisma.GenerationRunUpdateManyMutationInput;
    bookId: string;
    runId: string;
    bookData: Prisma.BookUpdateInput;
  }): Promise<CoordinatorOutcome> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const runUpdate = await tx.generationRun.updateMany({
          where: params.runWhere,
          data: params.runData,
        });
        if (runUpdate.count === 0) return 'stale_fence';

        const bookUpdate = await tx.book.updateMany({
          where: { id: params.bookId, activeRunId: params.runId },
          data: params.bookData,
        });
        if (bookUpdate.count === 0) {
          throw new BookMirrorMismatchError(
            `GenerationRun ${params.runId} (book ${params.bookId}) passed its fencing check, but Book.activeRunId no longer pointed at it — the run/Book mirror invariant is broken. Rolling back the entire transaction rather than leaving GenerationRun terminal while Book stays stuck.`,
          );
        }
        return 'applied';
      });
    } catch (err) {
      if (err instanceof BookMirrorMismatchError) {
        this.logger.error(err.message);
        return 'book_mirror_mismatch';
      }
      throw err;
    }
  }

  /**
   * Atomically, in one transaction:
   *   1. transitions GenerationRun to its terminal status, fenced on it still
   *      being `running` with the exact fencingVersion this attempt observed
   *      at claim time (see GenerationExecutionService.applyFencedBookWrite's
   *      doc comment for why this row-level check is a real guarantee, not a
   *      best-effort one);
   *   2. only if that held, applies `outcome.bookUpdate` plus
   *      status/errorMessage/failedStep to Book, clears activeRunId, and —
   *      only on success — atomically sets both publishedRunId AND
   *      publishedRunFencingVersion together (Phase B, Slice B4 — see
   *      resolvePublishedNamespace's doc comment for why the pair, not just
   *      publishedRunId, must always move together).
   *
   * This is the ONLY place a GenerationRun's own `completed`/`failed`
   * transition is ever paired with Book.status becoming `complete`/`failed`
   * from AgentService's own pipeline outcome — see failAbandoned for the
   * separate (but mechanically identical) path used when a run is finalized
   * without ever having produced a GenerationOutcome at all (BullMQ retry
   * exhaustion, abandoned-run recovery). Between the two, every terminal
   * GenerationRun/Book transition in this codebase goes through this class.
   */
  async completeRun(ctx: ClaimedRunRef, outcome: GenerationOutcome): Promise<CoordinatorOutcome> {
    const bookData: Prisma.BookUpdateInput = {
      ...outcome.bookUpdate,
      status: outcome.status,
      ...(outcome.errorMessage !== undefined && { errorMessage: outcome.errorMessage }),
      ...(outcome.failedStep !== undefined && { failedStep: outcome.failedStep }),
      activeRunId: null,
      ...(outcome.status === BookStatus.complete && {
        publishedRunId: ctx.runId,
        publishedRunFencingVersion: ctx.fencingVersion,
      }),
    };

    const result = await this.runFencedTerminalTransition({
      runWhere: {
        id: ctx.runId,
        status: GenerationRunStatus.running,
        fencingVersion: ctx.fencingVersion,
      },
      runData:
        outcome.status === BookStatus.complete
          ? {
              status: GenerationRunStatus.completed,
              completedAt: new Date(),
              currentStep: outcome.completedStep,
            }
          : {
              status: GenerationRunStatus.failed,
              failedAt: new Date(),
              errorCode: outcome.errorCode ?? 'GENERATION_FAILED',
              errorMessage: outcome.errorMessage ?? 'Generation failed',
              currentStep: outcome.completedStep,
            },
      bookId: ctx.bookId,
      runId: ctx.runId,
      bookData,
    });

    if (result === 'stale_fence') {
      this.logger.warn(
        `Run ${ctx.runId} (book ${ctx.bookId}) finished ${outcome.status} but its fencing guard found it already superseded — not touching Book.`,
      );
    }
    return result;
  }

  /**
   * Finalizes a claimed run whose stored input_snapshot failed validation —
   * called before AgentService ever runs, since there is no valid input to
   * execute. The caller must not rethrow after this: a malformed snapshot is
   * a permanent condition, not a transient one, so retrying via BullMQ would
   * only burn through every attempt and land on this exact same failure each
   * time (see GenerationQueueProcessor.process). Uses the stable
   * GENERATION_INPUT_SNAPSHOT_INVALID code (never a raw Zod issue list) so
   * diagnostics/clients can distinguish this from an ordinary generation
   * failure. Same fencing guarantee as completeRun.
   */
  async failInvalidSnapshot(ctx: ClaimedRunRef, errorMessage: string): Promise<CoordinatorOutcome> {
    const result = await this.runFencedTerminalTransition({
      runWhere: {
        id: ctx.runId,
        status: GenerationRunStatus.running,
        fencingVersion: ctx.fencingVersion,
      },
      runData: {
        status: GenerationRunStatus.failed,
        failedAt: new Date(),
        errorCode: GENERATION_INPUT_SNAPSHOT_INVALID,
        errorMessage,
      },
      bookId: ctx.bookId,
      runId: ctx.runId,
      bookData: { activeRunId: null, status: BookStatus.failed, errorMessage },
    });

    if (result === 'stale_fence') {
      this.logger.warn(
        `Run ${ctx.runId} (book ${ctx.bookId}) had an invalid input_snapshot but its fencing guard found it already superseded — not touching Book.`,
      );
    }
    return result;
  }

  /**
   * Finalizes a run that was never resolved by AgentService's own pipeline at
   * all — either BullMQ exhausted every delivery attempt without the job ever
   * completing (BooksService.markRunPermanentlyFailedAfterExhaustedRetries),
   * or a recovery pass found it abandoned by a dead/restarted process
   * (GenerationRunRecoveryService.recoverOne). Those two callers decide *when*
   * a run counts as abandoned and *what* code/message to report — this method
   * only owns the shared mechanism: the same fenced GenerationRun-then-Book
   * transaction every other terminal transition in this class uses.
   *
   * `ref.fromStatus` is `running` for the exhausted-retries caller (a claimed
   * run is always `running`) but can be `queued` for recovery, which also
   * fails runs that were never claimed at all (stuck in the outbox/dispatch
   * path) — the fence must match whichever status the caller actually
   * observed, not assume `running` unconditionally.
   */
  async failAbandoned(
    ref: AbandonedRunRef,
    params: { errorCode: string; errorMessage: string },
  ): Promise<CoordinatorOutcome> {
    const result = await this.runFencedTerminalTransition({
      runWhere: { id: ref.runId, status: ref.fromStatus, fencingVersion: ref.fencingVersion },
      runData: {
        status: GenerationRunStatus.failed,
        failedAt: new Date(),
        errorCode: params.errorCode,
        errorMessage: params.errorMessage,
      },
      bookId: ref.bookId,
      runId: ref.runId,
      bookData: {
        activeRunId: null,
        status: BookStatus.failed,
        failedStep: null,
        errorMessage: params.errorMessage,
      },
    });

    if (result === 'stale_fence') {
      this.logger.warn(
        `Run ${ref.runId} (book ${ref.bookId}) was abandoned but its fencing guard found it already superseded — not touching Book.`,
      );
    }
    return result;
  }
}
