import { Injectable } from '@nestjs/common';
import { AgentStep, GenerationRunStatus, Prisma, type Book } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { GenerationExecutionContext } from './generation-execution-context';

/**
 * Thrown by applyFencedBookWrite when the calling attempt no longer owns its
 * GenerationRun — a newer claim (a different worker's legitimate BullMQ
 * redelivery) or recovery already superseded it. Callers must treat this as
 * "abandon quietly," never as a reason to rethrow/retry: retrying would only
 * race the attempt that actually owns the run now.
 */
export class StaleGenerationRunError extends Error {
  constructor(runId: string, step: AgentStep) {
    super(`GenerationRun ${runId} is no longer owned by this attempt (step ${step}) — abandoning.`);
    this.name = 'StaleGenerationRunError';
  }
}

/**
 * The single choke point every pipeline mutation to a Book must go through
 * while a GenerationRun is executing (see AgentService). Replaces the old
 * pattern of unguarded `prisma.book.update({ where: { id } })` calls, which
 * had no way to detect that a newer attempt had already reclaimed the run.
 */
@Injectable()
export class GenerationExecutionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically (1) proves `ctx.fencingVersion` still matches the run's
   * current fencingVersion and it is still `running` — the same row-level
   * lock + WHERE-clause re-check Postgres performs for every UPDATE under
   * READ COMMITTED is what makes this correctly serialize against a
   * concurrent claim/heartbeat/complete/fail/recovery write to the *same*
   * GenerationRun row, not just an optimistic best-effort check — then (2),
   * only if that held, writes `bookData` to the Book row. Both statements run
   * in one transaction, so a stale attempt can never sneak a Book write in
   * between the fence check and the write.
   */
  async applyFencedBookWrite(
    ctx: GenerationExecutionContext,
    bookData: Prisma.BookUpdateInput,
    step: AgentStep,
  ): Promise<Book> {
    return this.prisma.$transaction(async (tx) => {
      const fenceCheck = await tx.generationRun.updateMany({
        where: {
          id: ctx.runId,
          status: GenerationRunStatus.running,
          fencingVersion: ctx.fencingVersion,
        },
        data: { currentStep: step },
      });
      if (fenceCheck.count === 0) {
        throw new StaleGenerationRunError(ctx.runId, step);
      }
      // Fencing already proven above within this same transaction — a plain
      // unique-key update is safe here (see this method's doc comment for
      // why no other attempt could have written Book in between).
      return tx.book.update({ where: { id: ctx.bookId }, data: bookData });
    });
  }
}
