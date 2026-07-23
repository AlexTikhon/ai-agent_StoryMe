import { HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BookStatus, GenerationRunStatus } from '@prisma/client';
import type { CancelGenerationResponse } from '@book/types';
import { AgentService } from '../agent/agent.service';
import type { GenerationExecutionContext } from '../agent/generation-execution-context';
import { StaleGenerationRunError } from '../agent/generation-execution.service';
import { GenerationJobService } from '../agent/generation-job.service';
import type { GenerationOutcome } from '../agent/generation-outcome';
import { GenerationQueueService } from '../agent/generation-queue.service';
import {
  GenerationRunCoordinator,
  GenerationRunMirrorInvariantError,
} from '../agent/generation-run-coordinator.service';
import { PrismaService } from '../database/prisma.service';
import { toBookDto } from './books.mapper';

export const BOOK_ALREADY_CANCELLED_CODE = 'BOOK_ALREADY_CANCELLED';
export const BOOK_NOT_IN_PROGRESS_CODE = 'BOOK_NOT_IN_PROGRESS';

function alreadyCancelledException(): HttpException {
  return new HttpException(
    {
      error: 'Book generation already cancelled',
      message: 'Book generation already cancelled',
      code: BOOK_ALREADY_CANCELLED_CODE,
    },
    HttpStatus.CONFLICT,
  );
}

function notInProgressException(): HttpException {
  return new HttpException(
    {
      error: 'Book is not currently generating',
      message: 'Book is not currently generating',
      code: BOOK_NOT_IN_PROGRESS_CODE,
    },
    HttpStatus.CONFLICT,
  );
}

/**
 * Owns the worker-side generation lifecycle after a run has been scheduled:
 * fenced execution/publication, cancellation follow-ups, and the exhausted
 * BullMQ retry backstop. GenerationRunCoordinator remains the owner of every
 * authoritative transaction; GenerationJob writes remain best-effort only.
 */
@Injectable()
export class BookGenerationExecutionService {
  private readonly logger = new Logger(BookGenerationExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentService: AgentService,
    private readonly generationQueueService: GenerationQueueService,
    private readonly generationJobService: GenerationJobService,
    private readonly generationRunCoordinator: GenerationRunCoordinator,
  ) {}

  async cancelGeneration(userId: string, bookId: string): Promise<CancelGenerationResponse> {
    const result = await this.generationRunCoordinator.cancelGeneration({ bookId, userId });

    switch (result.kind) {
      case 'not_found':
        throw new NotFoundException('Book not found');
      case 'already_cancelled':
        throw alreadyCancelledException();
      case 'not_in_progress':
        throw notInProgressException();
      case 'book_mirror_mismatch':
        throw new GenerationRunMirrorInvariantError(result.runId, result.bookId);
      case 'applied':
        break;
    }

    const legacyJob = await this.generationJobService.findActive(bookId).catch(() => null);
    if (legacyJob) {
      await this.markJob(
        this.generationJobService.markCancelled(legacyJob.id),
        legacyJob.id,
        bookId,
        'cancelled',
      );
    }
    await this.generationQueueService.removeIfSafe(result.runId);

    return { book: toBookDto(result.book), creditsRefunded: result.creditsRefunded };
  }

  async runGenerationPipeline(ctx: GenerationExecutionContext): Promise<void> {
    const { bookId, runId } = ctx;
    this.logger.log(`Starting generation pipeline — bookId=${bookId} runId=${runId}`);

    const legacyJob = await this.generationJobService.findActive(bookId).catch(() => null);
    if (legacyJob) {
      await this.markJob(
        this.generationJobService.markRunning(legacyJob.id),
        legacyJob.id,
        bookId,
        'running',
      );
    }

    let outcome: GenerationOutcome;
    try {
      outcome = await this.agentService.startBookGeneration(ctx);
      this.logger.log(`Book ${bookId} pipeline outcome -> ${outcome.status} (run ${runId})`);
    } catch (err) {
      if (err instanceof StaleGenerationRunError) {
        this.logger.warn(
          `Run ${runId} (book ${bookId}) was superseded mid-pipeline — abandoning this attempt without touching Book/GenerationRun further: ${err.message}`,
        );
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Generation pipeline threw unexpectedly for run ${runId} (book ${bookId}): ${message}`,
      );
      if (legacyJob) {
        await this.markJob(
          this.generationJobService.markFailed(legacyJob.id, { errorMessage: message }),
          legacyJob.id,
          bookId,
          'failed',
        );
      }
      throw err;
    }

    const published = await this.generationRunCoordinator.completeRun(ctx, outcome);
    if (published === 'book_mirror_mismatch') {
      throw new GenerationRunMirrorInvariantError(runId, bookId);
    }
    if (published !== 'applied') return;

    if (legacyJob) {
      if (outcome.status === BookStatus.failed) {
        await this.markJob(
          this.generationJobService.markFailed(legacyJob.id, {
            errorMessage: outcome.errorMessage ?? 'Generation failed',
            ...(outcome.failedStep !== undefined && { failedStep: outcome.failedStep }),
          }),
          legacyJob.id,
          bookId,
          'failed',
        );
      } else {
        await this.markJob(
          this.generationJobService.markCompleted(legacyJob.id),
          legacyJob.id,
          bookId,
          'completed',
        );
      }
    }
  }

  async markRunPermanentlyFailedAfterExhaustedRetries(runId: string): Promise<void> {
    const run = await this.prisma.generationRun.findUnique({ where: { id: runId } });
    if (!run || run.status !== GenerationRunStatus.running) return;

    const safeMessage = 'Generation failed after repeated errors — please retry.';
    const result = await this.generationRunCoordinator.failAbandoned(
      {
        runId: run.id,
        bookId: run.bookId,
        fencingVersion: run.fencingVersion,
        fromStatus: GenerationRunStatus.running,
      },
      { errorCode: 'GENERATION_INFRASTRUCTURE_FAILURE', errorMessage: safeMessage },
    );
    if (result === 'book_mirror_mismatch') {
      throw new GenerationRunMirrorInvariantError(run.id, run.bookId);
    }
    if (result !== 'applied') return;

    const legacyJob = await this.generationJobService.findActive(run.bookId).catch(() => null);
    if (legacyJob) {
      await this.markJob(
        this.generationJobService.markFailed(legacyJob.id, { errorMessage: safeMessage }),
        legacyJob.id,
        run.bookId,
        'failed',
      );
    }
  }

  private async markJob(
    update: Promise<unknown>,
    jobId: string,
    bookId: string,
    action: string,
  ): Promise<void> {
    await update.catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to mark generation job ${jobId} ${action} for book ${bookId}: ${message}`,
      );
    });
  }
}
