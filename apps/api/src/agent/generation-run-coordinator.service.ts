import { Injectable, Logger } from '@nestjs/common';
import { BookStatus, GenerationRunStatus, type Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { GenerationOutcome } from './generation-outcome';
import { GENERATION_INPUT_SNAPSHOT_INVALID } from './generation-input-snapshot';

/** The subset of a claimed GenerationRun's identity completeRun/failInvalidSnapshot actually need — a full GenerationExecutionContext (which also carries the parsed inputSnapshot) satisfies this structurally, but failInvalidSnapshot has no valid inputSnapshot to offer. */
export interface ClaimedRunRef {
  readonly runId: string;
  readonly bookId: string;
  readonly fencingVersion: number;
}

/**
 * The single choke point that publishes a GenerationRun's terminal outcome —
 * extracted out of BooksService (not just kept as a private method there) so
 * this exact production code path, not a hand-copied mirror of it, can be
 * exercised directly against a real Postgres in integration tests without
 * constructing all of BooksService's other dependencies (pdf storage, image
 * storage, rate limiter, etc.) — see "Test the production completion/failure
 * method, not a copied implementation" in the Phase A.1 hardening report.
 */
@Injectable()
export class GenerationRunCoordinator {
  private readonly logger = new Logger(GenerationRunCoordinator.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically, in one transaction:
   *   1. transitions GenerationRun to its terminal status, fenced on it still
   *      being `running` with the exact fencingVersion this attempt observed
   *      at claim time (see GenerationExecutionService.applyFencedBookWrite's
   *      doc comment for why this row-level check is a real guarantee, not a
   *      best-effort one);
   *   2. only if that held, applies `outcome.bookUpdate` plus
   *      status/errorMessage/failedStep to Book, clears activeRunId, and —
   *      only on success — sets publishedRunId.
   *
   * This is the ONLY place Book.status ever becomes `complete`/`failed` —
   * AgentService computes the outcome but never writes those three fields
   * itself (see GenerationOutcome's doc comment), so there is no window where
   * Book already looks terminal but GenerationRun/activeRunId do not agree: a
   * crash before this transaction commits leaves both non-terminal; a crash
   * after leaves both terminal and consistent. Returns false — Book and
   * GenerationRun both provably untouched — when a newer claim or recovery
   * already superseded this attempt.
   */
  async completeRun(ctx: ClaimedRunRef, outcome: GenerationOutcome): Promise<boolean> {
    const fenceWhere = {
      id: ctx.runId,
      status: GenerationRunStatus.running,
      fencingVersion: ctx.fencingVersion,
    };

    const claimedStillValid = await this.prisma.$transaction(async (tx) => {
      const runUpdate = await tx.generationRun.updateMany({
        where: fenceWhere,
        data:
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
      });
      if (runUpdate.count === 0) return false;

      const bookData: Prisma.BookUpdateInput = {
        ...outcome.bookUpdate,
        status: outcome.status,
        ...(outcome.errorMessage !== undefined && { errorMessage: outcome.errorMessage }),
        ...(outcome.failedStep !== undefined && { failedStep: outcome.failedStep }),
      };
      await tx.book.updateMany({
        where: { id: ctx.bookId, activeRunId: ctx.runId },
        data: {
          ...bookData,
          activeRunId: null,
          ...(outcome.status === BookStatus.complete && { publishedRunId: ctx.runId }),
        },
      });
      return true;
    });

    if (!claimedStillValid) {
      this.logger.warn(
        `Run ${ctx.runId} (book ${ctx.bookId}) finished ${outcome.status} but its fencing guard found it already superseded — not touching Book.`,
      );
    }
    return claimedStillValid;
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
   * failure. Same fencing guarantee as completeRun: a no-op, Book/GenerationRun
   * both untouched, if a newer claim or recovery already superseded this run.
   */
  async failInvalidSnapshot(ctx: ClaimedRunRef, errorMessage: string): Promise<boolean> {
    const claimedStillValid = await this.prisma.$transaction(async (tx) => {
      const runUpdate = await tx.generationRun.updateMany({
        where: {
          id: ctx.runId,
          status: GenerationRunStatus.running,
          fencingVersion: ctx.fencingVersion,
        },
        data: {
          status: GenerationRunStatus.failed,
          failedAt: new Date(),
          errorCode: GENERATION_INPUT_SNAPSHOT_INVALID,
          errorMessage,
        },
      });
      if (runUpdate.count === 0) return false;

      await tx.book.updateMany({
        where: { id: ctx.bookId, activeRunId: ctx.runId },
        data: { activeRunId: null, status: BookStatus.failed, errorMessage },
      });
      return true;
    });

    if (!claimedStillValid) {
      this.logger.warn(
        `Run ${ctx.runId} (book ${ctx.bookId}) had an invalid input_snapshot but its fencing guard found it already superseded — not touching Book.`,
      );
    }
    return claimedStillValid;
  }
}
