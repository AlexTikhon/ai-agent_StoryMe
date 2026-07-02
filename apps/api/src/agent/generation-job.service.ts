import { Injectable } from '@nestjs/common';
import { GenerationJobStatus, GenerationJobType, type AgentStep, type GenerationJob } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

/**
 * Persisted record of one generation attempt (generate or retry) — tracked
 * alongside, not instead of, Book.status (which stays the source of truth
 * for user-facing status). The in-process GenerationTaskRunner still does
 * the actual scheduling/execution; this service only records job state so
 * generation attempts are inspectable and a future durable queue has a
 * typed model to migrate onto. See "Generation jobs (Phase 3I)" in
 * apps/api/docs/local-generation-pipeline.md.
 */
@Injectable()
export class GenerationJobService {
  constructor(private readonly prisma: PrismaService) {}

  /** The book's in-flight job, if any — used to reject a second concurrent generate/retry. */
  findActive(bookId: string): Promise<GenerationJob | null> {
    return this.prisma.generationJob.findFirst({
      where: { bookId, status: { in: [GenerationJobStatus.queued, GenerationJobStatus.running] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** The book's most recent job of any status — used for diagnostics. */
  findLatest(bookId: string): Promise<GenerationJob | null> {
    return this.prisma.generationJob.findFirst({
      where: { bookId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Queued/running jobs last touched before `cutoff` — used by
   * GenerationJobRecoveryService (Phase 3J) to find jobs abandoned by a
   * process that died or restarted. `updatedAt` covers both cases: it equals
   * `createdAt` for a job still `queued` (never updated since creation) and
   * reflects `markRunning`'s `startedAt` write for a `running` job.
   */
  findStaleActiveJobs(cutoff: Date): Promise<GenerationJob[]> {
    return this.prisma.generationJob.findMany({
      where: {
        status: { in: [GenerationJobStatus.queued, GenerationJobStatus.running] },
        updatedAt: { lt: cutoff },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  createQueued(params: {
    bookId: string;
    userId: string;
    type: GenerationJobType;
    attempt: number;
  }): Promise<GenerationJob> {
    return this.prisma.generationJob.create({
      data: {
        bookId: params.bookId,
        userId: params.userId,
        type: params.type,
        attempt: params.attempt,
        status: GenerationJobStatus.queued,
      },
    });
  }

  markRunning(jobId: string): Promise<GenerationJob> {
    return this.prisma.generationJob.update({
      where: { id: jobId },
      data: { status: GenerationJobStatus.running, startedAt: new Date() },
    });
  }

  markCompleted(jobId: string): Promise<GenerationJob> {
    return this.prisma.generationJob.update({
      where: { id: jobId },
      data: { status: GenerationJobStatus.completed, completedAt: new Date() },
    });
  }

  markFailed(
    jobId: string,
    params: { errorMessage: string; failedStep?: AgentStep | null },
  ): Promise<GenerationJob> {
    return this.prisma.generationJob.update({
      where: { id: jobId },
      data: {
        status: GenerationJobStatus.failed,
        failedAt: new Date(),
        errorMessage: params.errorMessage,
        failedStep: params.failedStep ?? null,
      },
    });
  }
}
