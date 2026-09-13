import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { BookHardDeletionService } from '../books/book-hard-deletion.service';
import { QUEUES } from '../queue/queues.config';
import type { BookDeletionQueueJobData } from './generation-queue.service';
import { runWithCorrelation } from '../common/correlation/correlation-context';
import { operationalMetrics } from '../observability/operational-metrics';

/** Dedicated maintenance capacity independent from long book jobs. */
@Processor(QUEUES.MAINTENANCE)
export class MaintenanceQueueProcessor extends WorkerHost {
  constructor(private readonly deletion: BookHardDeletionService) {
    super();
  }

  async process(job: Job<BookDeletionQueueJobData>): Promise<void> {
    return runWithCorrelation(
      {
        ...(job.data.requestId && { requestId: job.data.requestId }),
        ...(job.id != null && { jobId: String(job.id) }),
        bookId: job.data.bookId,
        deletionRequestId: job.data.deletionRequestId,
        attempt: job.attemptsMade + 1,
      },
      async () => {
        const startedAt = Date.now();
        operationalMetrics.observe(
          'storyme_queue_wait_ms',
          Math.max(0, (job.processedOn ?? startedAt) - job.timestamp),
          { queue: 'maintenance' },
        );
        try {
          await this.deletion.process(job.data.deletionRequestId);
        } finally {
          operationalMetrics.observe('storyme_worker_processing_ms', Date.now() - startedAt, {
            queue: 'maintenance',
          });
        }
      },
    );
  }
}
