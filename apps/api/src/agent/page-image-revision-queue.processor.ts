import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { BookPageImageRevisionService } from '../books/book-page-image-revision.service';
import { QUEUES } from '../queue/queues.config';
import type { PageImageRevisionQueueJobData } from './generation-queue.service';
import { asGenerationFailure } from '../common/provider-execution';

/** Dedicated capacity so whole-book generation cannot starve revisions. */
@Processor(QUEUES.PAGE_IMAGE_REVISION)
export class PageImageRevisionQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(PageImageRevisionQueueProcessor.name);
  constructor(private readonly revisions: BookPageImageRevisionService) {
    super();
  }

  async process(job: Job<PageImageRevisionQueueJobData>, token?: string): Promise<void> {
    if (!token)
      throw new Error(`Page image revision ${job.data.revisionId} has no delivery token.`);
    const claimed = await this.revisions.claim(job.data.revisionId, token);
    if (!claimed) return;
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
