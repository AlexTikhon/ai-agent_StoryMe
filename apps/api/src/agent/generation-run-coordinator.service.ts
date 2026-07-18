import { Injectable, Logger } from '@nestjs/common';
import { BookStatus, GenerationRunStatus, type Book, type Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  CreditsService,
  generationCancellationRefundIdempotencyKey,
  generationChargeIdempotencyKey,
  generationRefundIdempotencyKey,
} from '../credits/credits.service';
import { OUTBOX_STATUS_CANCELLED, OUTBOX_STATUS_PENDING } from '../outbox/outbox.service';
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

/**
 * Internal-only signal used to abort (and thus roll back) a transaction whose
 * Book write matched zero rows despite its GenerationRun fence holding — see
 * CoordinatorOutcome's 'book_mirror_mismatch' doc. Never escapes this file.
 * Carries the run/book identity (optional — runFencedTerminalTransition's own
 * callers already know both from `params`, but cancelGeneration resolves them
 * inside its own transaction and needs them back at its catch site to build a
 * typed CancelGenerationOutcome) purely for that one extra caller's benefit.
 */
class BookMirrorMismatchError extends Error {
  constructor(
    message: string,
    readonly runId?: string,
    readonly bookId?: string,
  ) {
    super(message);
  }
}

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
 * Phase G1: result of GenerationRunCoordinator.cancelGeneration — a richer
 * discriminated union than CoordinatorOutcome because the caller (BooksService
 * .cancelGeneration) must map several distinct "nothing was cancelled"
 * reasons to different stable HTTP responses (404 vs. two different 409
 * codes), not just one generic "not applied":
 *
 *   - 'applied' — the run was queued/running and is now cancelled; `book` is
 *     the fully reloaded row (including any refund-free/refunded credit
 *     side effect already committed), `creditsRefunded` is the exact amount
 *     refunded (0 for a legacy/unbilled run), and `runId` is the cancelled
 *     run's id — returned so a caller can drive best-effort post-commit
 *     cleanup (BooksService.cancelGeneration's BullMQ removal) without a
 *     second lookup.
 *   - 'not_found' — no Book with this id belongs to this user (never
 *     distinguished from "doesn't exist at all" — see findOwnedOrThrow's own
 *     doc comment for why).
 *   - 'already_cancelled' — this book's generation was already cancelled
 *     (by an earlier request, or a request that's racing this one and won).
 *   - 'not_in_progress' — the book has no active (queued/running) run right
 *     now, for any other reason: never started (`created`), or already
 *     `complete`/`failed`/`partial` — including the specific race where a
 *     concurrent completion won before this cancellation's fenced write ran.
 *   - 'book_mirror_mismatch' — the GenerationRun fence held but
 *     Book.activeRunId no longer pointed at it; see CoordinatorOutcome's own
 *     doc comment for why this is an invariant failure, never folded into
 *     'not_in_progress'.
 */
export type CancelGenerationOutcome =
  | {
      readonly kind: 'applied';
      readonly book: Book;
      readonly creditsRefunded: number;
      readonly runId: string;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'already_cancelled' }
  | { readonly kind: 'not_in_progress' }
  | { readonly kind: 'book_mirror_mismatch'; readonly runId: string; readonly bookId: string };

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly creditsService: CreditsService,
  ) {}

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
    /**
     * AgentLog rows to persist alongside this transition — only ever
     * inserted after both the GenerationRun fence and the Book mirror check
     * above have held, and inside the very same transaction, so a stale or
     * superseded claim (whichever check fails first) writes zero AgentLog
     * rows, exactly like it writes no other durable state (see
     * GenerationOutcome.agentLogs's doc comment).
     */
    agentLogs?: readonly Prisma.AgentLogCreateManyInput[];
    /**
     * Whether this transition, once applied, should also refund the run's
     * original charge — true for every terminal-*failure* path
     * (completeRun's failed branch, failInvalidSnapshot, failAbandoned),
     * always false for a success. Applied only after the GenerationRun
     * fence and Book mirror check both hold (same ordering/placement as
     * agentLogs above), and only when a matching charge CreditTransaction
     * actually exists for this run — see refundIfCharged's doc comment for
     * why eligibility is derived from that row, never from run status
     * alone.
     */
    refundOnApply?: boolean;
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

        if (params.agentLogs && params.agentLogs.length > 0) {
          await tx.agentLog.createMany({
            data: params.agentLogs as Prisma.AgentLogCreateManyInput[],
          });
        }

        if (params.refundOnApply) {
          await this.refundIfCharged(tx, params.runId);
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
   * Refunds a failed run's original charge, but only if one actually
   * exists — a run created before Phase E2 (or one whose scheduling
   * transaction never reached the charge, though that can't happen for a
   * run that got this far, since charge and run-creation are the same
   * transaction) has no CreditTransaction at
   * generationChargeIdempotencyKey(runId), and must never receive a free
   * credit. The charge row itself — not GenerationRun.status — is the
   * source of truth for eligibility, and also supplies the refund's
   * amount/user/book: deriving those from the run or hardcoding
   * GENERATION_CREDIT_COST would refund the wrong amount (or the wrong
   * user/book entirely) if a future policy ever prices runs differently, or
   * silently credit a legacy run this lookup was specifically added to
   * exclude. The idempotency key on the refund itself
   * (generationRefundIdempotencyKey) is defense-in-depth on top of the
   * fencing this method's caller already provides — by the time this runs,
   * the GenerationRun fence and Book mirror check above have both held, so
   * a stale/superseded or already-terminal run's second attempt never
   * reaches here at all.
   */
  private async refundIfCharged(tx: Prisma.TransactionClient, runId: string): Promise<void> {
    const charge = await tx.creditTransaction.findUnique({
      where: { idempotencyKey: generationChargeIdempotencyKey(runId) },
    });
    if (!charge) {
      this.logger.log(
        `Run ${runId} has no matching charge CreditTransaction — treating as a legacy/unbilled run and skipping refund.`,
      );
      return;
    }

    await this.creditsService.addInTransaction(tx, {
      userId: charge.userId,
      amount: -charge.amount,
      reason: 'refund_generation_failure',
      ...(charge.bookId && { bookId: charge.bookId }),
      idempotencyKey: generationRefundIdempotencyKey(runId),
    });
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
      agentLogs: outcome.agentLogs,
      refundOnApply: outcome.status !== BookStatus.complete,
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
      refundOnApply: true,
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
      refundOnApply: true,
    });

    if (result === 'stale_fence') {
      this.logger.warn(
        `Run ${ref.runId} (book ${ref.bookId}) was abandoned but its fencing guard found it already superseded — not touching Book.`,
      );
    }
    return result;
  }

  /**
   * Phase G1 — the authoritative user-initiated cancellation transaction.
   * Unlike completeRun/failInvalidSnapshot/failAbandoned (which all fence a
   * *pre-resolved* claim a background caller already owns), this method also
   * owns resolving *and verifying* that identity itself — cancellation is
   * HTTP-request-driven, so ownership can never be assumed the way it is for
   * a claim the pipeline itself created. Everything below runs inside one
   * Prisma transaction:
   *
   *   1. Load `Book`, scoped to `(id, userId, deletedAt: null)` — a missing/
   *      not-owned/soft-deleted book is indistinguishable, both `'not_found'`.
   *   2. If `Book.activeRunId` is null, there is no active run to cancel —
   *      report `'already_cancelled'` if the book's own status already says
   *      so, otherwise `'not_in_progress'` (covers `created`, `complete`,
   *      `failed`, `partial`).
   *   3. Otherwise load that exact `GenerationRun` (scoped to `id, bookId,
   *      userId` — the same three-way ownership check `runWhere` below
   *      re-verifies in the actual fenced write) and read its current
   *      `status`/`fencingVersion`.
   *   4. Conditionally transition it to `cancelled` — fenced on run id, book
   *      id, user id, its exact observed status (`queued` or `running` only),
   *      and its exact observed `fencingVersion` — while also incrementing
   *      `fencingVersion`, so any already-running worker's next heartbeat (or
   *      its own next `applyFencedBookWrite`/`completeRun` call) loses
   *      ownership immediately, the same fencing guarantee every other
   *      terminal transition in this class already provides.
   *   5. If that fenced write matched zero rows, something else won the race
   *      (a concurrent cancellation, or a concurrent completion) — re-read
   *      the run once more to report the accurate outcome (`'already_cancelled'`
   *      if it's now `cancelled`, `'not_in_progress'` otherwise, e.g. a
   *      completion won).
   *   6. Only if the run transition held: conditionally update `Book`
   *      (`activeRunId` still pointing at this run) to `status: cancelled`,
   *      clear `activeRunId`/`errorMessage`/`failedStep` — deliberately never
   *      touching `previewPdfUrl`/`pdfUrl`/`bookPreview`/etc., so a
   *      previously published pointer from an earlier successful run survives
   *      a later regeneration's cancellation untouched. Zero rows matched
   *      here means the run/Book mirror invariant is broken — the whole
   *      transaction rolls back (`'book_mirror_mismatch'`), exactly like
   *      runFencedTerminalTransition's own handling.
   *   7. Suppress any still-`pending` OutboxEvent for this run
   *      (`OUTBOX_STATUS_CANCELLED`) so a dispatcher sweep can never newly
   *      enqueue it — a sweep that already read it as pending before this
   *      commits may still enqueue the BullMQ job, but GenerationRunService
   *      .claim then finds the run no longer queued/running and returns null,
   *      a safe no-op (see GenerationQueueProcessor.process).
   *   8. Look up the original charge (`generationChargeIdempotencyKey`) and,
   *      only if one exists, refund its exact amount/user/book via
   *      CreditsService.addInTransaction with reason
   *      `refund_generation_cancelled` and a distinct deterministic key
   *      (`generationCancellationRefundIdempotencyKey`) — never
   *      `refund_generation_failure`, and never a hardcoded amount. A
   *      legacy/unbilled run has no matching charge and is cancelled with
   *      `creditsRefunded: 0`.
   *
   * Any failure at any step (including the refund insert hitting its own
   * idempotency-key conflict) throws out of the transaction callback and
   * rolls back every write made so far in this same call — there is no
   * partial-cancellation state this method can leave behind.
   */
  async cancelGeneration(params: {
    bookId: string;
    userId: string;
  }): Promise<CancelGenerationOutcome> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const book = await tx.book.findFirst({
          where: { id: params.bookId, userId: params.userId, deletedAt: null },
        });
        if (!book) return { kind: 'not_found' };

        if (!book.activeRunId) {
          return book.status === BookStatus.cancelled
            ? { kind: 'already_cancelled' }
            : { kind: 'not_in_progress' };
        }

        const run = await tx.generationRun.findFirst({
          where: { id: book.activeRunId, bookId: book.id, userId: params.userId },
        });
        const isActive =
          run !== null &&
          (run.status === GenerationRunStatus.queued || run.status === GenerationRunStatus.running);
        if (!isActive) {
          return run?.status === GenerationRunStatus.cancelled
            ? { kind: 'already_cancelled' }
            : { kind: 'not_in_progress' };
        }

        const runUpdate = await tx.generationRun.updateMany({
          where: {
            id: run.id,
            bookId: book.id,
            userId: params.userId,
            status: run.status,
            fencingVersion: run.fencingVersion,
          },
          data: {
            status: GenerationRunStatus.cancelled,
            cancelledAt: new Date(),
            fencingVersion: { increment: 1 },
          },
        });
        if (runUpdate.count === 0) {
          // Lost a race against a concurrent cancellation or a concurrent
          // completion — re-read to report which one actually won, rather
          // than guessing from the pre-write snapshot above.
          const latest = await tx.generationRun.findUnique({ where: { id: run.id } });
          return latest?.status === GenerationRunStatus.cancelled
            ? { kind: 'already_cancelled' }
            : { kind: 'not_in_progress' };
        }

        const bookUpdate = await tx.book.updateMany({
          where: { id: book.id, userId: params.userId, activeRunId: run.id },
          data: {
            status: BookStatus.cancelled,
            activeRunId: null,
            errorMessage: null,
            failedStep: null,
          },
        });
        if (bookUpdate.count === 0) {
          throw new BookMirrorMismatchError(
            `GenerationRun ${run.id} (book ${book.id}) passed its cancellation fencing check, but Book.activeRunId no longer pointed at it — the run/Book mirror invariant is broken. Rolling back the entire cancellation transaction rather than leaving GenerationRun cancelled while Book stays stuck.`,
            run.id,
            book.id,
          );
        }

        // Suppress a still-pending outbox event so a dispatcher sweep can
        // never newly enqueue this cancelled run — see this method's own doc
        // comment, point 7, for why a sweep that already read it as pending
        // before this commits is still safe (claim() becomes a no-op).
        await tx.outboxEvent.updateMany({
          where: {
            aggregateType: 'generation_run',
            aggregateId: run.id,
            status: OUTBOX_STATUS_PENDING,
          },
          data: { status: OUTBOX_STATUS_CANCELLED },
        });

        let creditsRefunded = 0;
        const charge = await tx.creditTransaction.findUnique({
          where: { idempotencyKey: generationChargeIdempotencyKey(run.id) },
        });
        if (charge) {
          await this.creditsService.addInTransaction(tx, {
            userId: charge.userId,
            amount: -charge.amount,
            reason: 'refund_generation_cancelled',
            ...(charge.bookId && { bookId: charge.bookId }),
            idempotencyKey: generationCancellationRefundIdempotencyKey(run.id),
          });
          creditsRefunded = -charge.amount;
        } else {
          this.logger.log(
            `Run ${run.id} has no matching charge CreditTransaction — cancelling as a legacy/unbilled run with creditsRefunded: 0.`,
          );
        }

        const updatedBook = await tx.book.findUniqueOrThrow({ where: { id: book.id } });
        return { kind: 'applied', book: updatedBook, creditsRefunded, runId: run.id };
      });
    } catch (err) {
      if (err instanceof BookMirrorMismatchError) {
        this.logger.error(err.message);
        return {
          kind: 'book_mirror_mismatch',
          runId: err.runId ?? '',
          bookId: err.bookId ?? params.bookId,
        };
      }
      throw err;
    }
  }
}
