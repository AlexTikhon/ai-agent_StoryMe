import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { BookStatus, type GenerationJob } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { GenerationJobService } from './generation-job.service';

export const DEFAULT_GENERATION_JOB_STALE_AFTER_MS = 30 * 60 * 1000;

/** Safe, user-facing message — never a stack trace or provider error detail. */
export const GENERATION_INTERRUPTED_MESSAGE =
  'Generation was interrupted before completion. Please retry.';

/** Books in these statuses are left untouched by recovery — already done, already failed, or explicitly ended. */
const TERMINAL_BOOK_STATUSES = new Set<BookStatus>([
  BookStatus.complete,
  BookStatus.failed,
  BookStatus.partial,
  BookStatus.cancelled,
]);

export interface RecoverySummary {
  staleJobsFound: number;
  jobsRecovered: number;
  errors: number;
}

/** Reads GENERATION_JOB_STALE_AFTER_MS from env, falling back to a safe default when missing or malformed. */
export function readGenerationJobStaleAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['GENERATION_JOB_STALE_AFTER_MS'];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_GENERATION_JOB_STALE_AFTER_MS;
}

/**
 * Runs once on app bootstrap to fail-safe any GenerationJob left `queued`/
 * `running` by a previous process that died or restarted. The in-process
 * GenerationTaskRunner (Phase 3H) has no memory of scheduled tasks across a
 * restart, so without this a book could stay stuck in a non-terminal
 * "generating" status forever. Recovery never resumes or re-runs generation
 * — it only marks the stale job/book `failed` so the user can retry via the
 * existing retry-generation flow (Phase 3G). See "Startup recovery
 * (Phase 3J)" in apps/api/docs/local-generation-pipeline.md.
 */
@Injectable()
export class GenerationJobRecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(GenerationJobRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly generationJobService: GenerationJobService,
  ) {}

  /** Never throws — a recovery failure is logged and the app still boots. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const summary = await this.recover(readGenerationJobStaleAfterMs());
      this.logger.log(
        `Generation job recovery: found ${summary.staleJobsFound} stale job(s), ` +
          `recovered ${summary.jobsRecovered}, ${summary.errors} error(s)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Generation job recovery failed to run: ${message}`);
    }
  }

  async recover(staleAfterMs: number, now: Date = new Date()): Promise<RecoverySummary> {
    const cutoff = new Date(now.getTime() - staleAfterMs);
    const staleJobs = await this.generationJobService.findStaleActiveJobs(cutoff);

    let jobsRecovered = 0;
    let errors = 0;
    for (const job of staleJobs) {
      try {
        await this.recoverOne(job);
        jobsRecovered += 1;
      } catch (err) {
        errors += 1;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to recover generation job ${job.id}: ${message}`);
      }
    }

    return { staleJobsFound: staleJobs.length, jobsRecovered, errors };
  }

  private async recoverOne(job: GenerationJob): Promise<void> {
    await this.generationJobService.markFailed(job.id, {
      errorMessage: GENERATION_INTERRUPTED_MESSAGE,
    });

    const book = await this.prisma.book.findUnique({ where: { id: job.bookId } });
    if (book && !TERMINAL_BOOK_STATUSES.has(book.status)) {
      await this.prisma.book.update({
        where: { id: job.bookId },
        data: {
          status: BookStatus.failed,
          failedStep: null,
          errorMessage: GENERATION_INTERRUPTED_MESSAGE,
        },
      });
    }
  }
}
