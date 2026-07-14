import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { GenerationJob } from '@prisma/client';
import { GenerationJobService } from './generation-job.service';

export const DEFAULT_GENERATION_JOB_STALE_AFTER_MS = 30 * 60 * 1000;

/** Safe, user-facing message — never a stack trace or provider error detail. */
export const GENERATION_INTERRUPTED_MESSAGE =
  'Generation was interrupted before completion. Please retry.';

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
 * `running` by a previous process that died or restarted.
 *
 * IMPORTANT (Phase 2): GenerationJob is no longer the authority for
 * dispatch/concurrency or Book.status — GenerationRun is (see
 * BooksService.createRunAndSchedule, GenerationRunRecoveryService). This
 * service now only cleans up the legacy GenerationJob diagnostics mirror
 * itself and deliberately never touches Book anymore: it used to also mark
 * Book.status failed based purely on GenerationJob row age, which — now that
 * a book's real generation state lives in GenerationRun — could have
 * incorrectly failed a book whose actual (GenerationRun-driven) pipeline was
 * still legitimately running, since this service's own age heuristic has no
 * visibility into GenerationRun or BullMQ at all. GenerationRunRecoveryService
 * is the only thing that may now transition Book.status during recovery, and
 * it checks BullMQ's own state before doing so (invariant F in
 * docs/local-generation-pipeline.md). See "Startup recovery (Phase 3J)" and
 * "Durable generation queue (Phase 3K)" in
 * apps/api/docs/local-generation-pipeline.md.
 */
@Injectable()
export class GenerationJobRecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(GenerationJobRecoveryService.name);

  constructor(private readonly generationJobService: GenerationJobService) {}

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
  }
}
