import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { BookPageImageRevisionService } from '../books/book-page-image-revision.service';
import { QUEUES } from '../queue/queues.config';
import type { PageImageRevisionQueueJobData } from './generation-queue.service';
import { asGenerationFailure } from '../common/provider-execution';
import { extendCorrelation, runWithCorrelation } from '../common/correlation/correlation-context';
import { operationalMetrics } from '../observability/operational-metrics';

/** Dedicated capacity so whole-book generation cannot starve revisions. */
@Processor(QUEUES.PAGE_IMAGE_REVISION)
export class PageImageRevisionQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(PageImageRevisionQueueProcessor.name);
  constructor(private readonly revisions: BookPageImageRevisionService) {
    super();
  }

  async process(job: Job<PageImageRevisionQueueJobData>, token?: string): Promise<void> {
    return runWithCorrelation(
      {
        ...(job.data.requestId && { requestId: job.data.requestId }),
        ...(job.id != null && { jobId: String(job.id) }),
        bookId: job.data.bookId,
        revisionId: job.data.revisionId,
        attempt: job.attemptsMade + 1,
      },
      async () => {
        const startedAt = Date.now();
        operationalMetrics.observe(
          'storyme_queue_wait_ms',
          Math.max(0, (job.processedOn ?? startedAt) - job.timestamp),
          { queue: 'page_revision' },
        );
        try {
          await this.processCorrelated(job, token);
        } finally {
          operationalMetrics.observe('storyme_worker_processing_ms', Date.now() - startedAt, {
            queue: 'page_revision',
          });
        }
      },
    );
  }

  private async processCorrelated(
    job: Job<PageImageRevisionQueueJobData>,
    token?: string,
  ): Promise<void> {
    if (!token)
      throw new Error(`Page image revision ${job.data.revisionId} has no delivery token.`);
    const claimed = await this.revisions.claim(job.data.revisionId, token);
    if (!claimed) return;
    extendCorrelation({ fence: claimed.fencingVersion });
    try {
      await this.revisions.executeClaimed(claimed.id, claimed.fencingVersion);
    } catch (error) {
      const failure = asGenerationFailure(error);
      await this.revisions
        .failAndRefund(
          claimed.id,
          `PAGE_IMAGE_${failure.reason.toUpperCase()}`,
          'The page illustration could not be regenerated. The previous book is unchanged.',
          claimed.fencingVersion,
          failure.reason,
        )
        .catch((finalizeError: unknown) => {
          this.logger.error(
            `Failed to finalize page image revision ${claimed.id}: ${finalizeError instanceof Error ? finalizeError.message : String(finalizeError)}`,
          );
        });
      throw failure;
    }
  }
}
