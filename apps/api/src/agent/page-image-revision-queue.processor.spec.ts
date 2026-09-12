import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { GenerationControlError } from '../common/provider-execution';
import { PageImageRevisionQueueProcessor } from './page-image-revision-queue.processor';
import type { PageImageRevisionQueueJobData } from './generation-queue.service';

describe('PageImageRevisionQueueProcessor typed failures', () => {
  it.each(['provider_transient_failure', 'refusal', 'invalid_output', 'storage_failure'] as const)(
    'carries %s through worker finalization as one typed outcome',
    async (reason) => {
      const failure = new GenerationControlError(reason, 'safe typed failure');
      const revisions = {
        claim: vi.fn().mockResolvedValue({ id: 'revision-1', fencingVersion: 7 }),
        executeClaimed: vi.fn().mockRejectedValue(failure),
        failAndRefund: vi.fn().mockResolvedValue(undefined),
      };
      const processor = new PageImageRevisionQueueProcessor(revisions as never);
      const job = {
        data: {
          kind: 'page_image_revision',
          bookId: 'book-1',
          revisionId: 'revision-1',
        },
      } as Job<PageImageRevisionQueueJobData>;

      await expect(processor.process(job, 'delivery-token')).rejects.toBe(failure);
      expect(revisions.failAndRefund).toHaveBeenCalledWith(
        'revision-1',
        `PAGE_IMAGE_${reason.toUpperCase()}`,
        expect.any(String),
        7,
        reason,
      );
    },
  );

  it('does not hide the typed failure when the finalization database write is unavailable', async () => {
    const failure = new GenerationControlError('storage_failure', 'safe typed failure');
    const revisions = {
      claim: vi.fn().mockResolvedValue({ id: 'revision-1', fencingVersion: 7 }),
      executeClaimed: vi.fn().mockRejectedValue(failure),
      failAndRefund: vi.fn().mockRejectedValue(new Error('database unavailable')),
    };
    const processor = new PageImageRevisionQueueProcessor(revisions as never);
    const job = {
      data: {
        kind: 'page_image_revision',
        bookId: 'book-1',
        revisionId: 'revision-1',
      },
    } as Job<PageImageRevisionQueueJobData>;

    await expect(processor.process(job, 'delivery-token')).rejects.toBe(failure);
  });
});
