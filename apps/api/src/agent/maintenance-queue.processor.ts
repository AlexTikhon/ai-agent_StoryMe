import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { BookHardDeletionService } from '../books/book-hard-deletion.service';
import { QUEUES } from '../queue/queues.config';
import type { BookDeletionQueueJobData } from './generation-queue.service';

/** Dedicated maintenance capacity independent from long book jobs. */
@Processor(QUEUES.MAINTENANCE)
export class MaintenanceQueueProcessor extends WorkerHost {
  constructor(private readonly deletion: BookHardDeletionService) {
    super();
  }

  async process(job: Job<BookDeletionQueueJobData>): Promise<void> {
    await this.deletion.process(job.data.deletionRequestId);
  }
}
