import { describe, it, expect, vi } from 'vitest';
import type { OutboxEvent } from '@prisma/client';
import { OutboxDispatcherService } from './outbox-dispatcher.service';
import type { OutboxService } from './outbox.service';
import type { GenerationQueueService } from '../agent/generation-queue.service';

function makeEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: 'event-1',
    aggregateType: 'generation_run',
    aggregateId: 'run-1',
    eventType: 'run_queued',
    payload: { bookId: 'b-1', runId: 'run-1' },
    status: 'pending',
    attempts: 0,
    createdAt: new Date('2026-01-01'),
    dispatchedAt: null,
    ...overrides,
  };
}

function createMockOutboxService(pending: OutboxEvent[] = []): jest.Mocked<OutboxService> {
  return {
    findPending: vi.fn().mockResolvedValue(pending),
    markDispatched: vi.fn().mockResolvedValue(undefined),
    recordAttemptFailure: vi.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<OutboxService>;
}

function createMockQueueService(): jest.Mocked<GenerationQueueService> {
  return {
    enqueue: vi.fn().mockResolvedValue(undefined),
    enqueuePageImageRevision: vi.fn().mockResolvedValue(undefined),
    enqueueBookDeletion: vi.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<GenerationQueueService>;
}

describe('OutboxDispatcherService', () => {
  describe('sweep', () => {
    it('dispatches every pending event to BullMQ and marks each dispatched', async () => {
      const outboxService = createMockOutboxService([
        makeEvent(),
        makeEvent({
          id: 'event-2',
          aggregateId: 'run-2',
          payload: { bookId: 'b-2', runId: 'run-2' },
        }),
      ]);
      const queueService = createMockQueueService();
      const dispatcher = new OutboxDispatcherService(outboxService as never, queueService as never);

      await dispatcher.sweep();

      expect(queueService.enqueue).toHaveBeenCalledWith({ bookId: 'b-1', runId: 'run-1' });
      expect(queueService.enqueue).toHaveBeenCalledWith({ bookId: 'b-2', runId: 'run-2' });
      expect(outboxService.markDispatched).toHaveBeenCalledWith('event-1');
      expect(outboxService.markDispatched).toHaveBeenCalledWith('event-2');
    });

    it('propagates a valid request ID and drops malformed correlation metadata', async () => {
      const requestId = '44444444-4444-4444-8444-444444444444';
      const outboxService = createMockOutboxService([
        makeEvent({ payload: { bookId: 'b-1', runId: 'run-1', requestId } }),
        makeEvent({
          id: 'event-2',
          aggregateId: 'run-2',
          payload: {
            bookId: 'b-2',
            runId: 'run-2',
            requestId: 'forged\nprompt=private',
          },
        }),
      ]);
      const queueService = createMockQueueService();
      const dispatcher = new OutboxDispatcherService(outboxService as never, queueService as never);

      await dispatcher.sweep();

      expect(queueService.enqueue).toHaveBeenNthCalledWith(1, {
        bookId: 'b-1',
        runId: 'run-1',
        requestId,
      });
      expect(queueService.enqueue).toHaveBeenNthCalledWith(2, {
        bookId: 'b-2',
        runId: 'run-2',
      });
    });

    it('dispatches a durable page-image revision without treating it as a whole-book run', async () => {
      const outboxService = createMockOutboxService([
        makeEvent({
          aggregateType: 'page_image_revision',
          aggregateId: 'revision-1',
          eventType: 'page_image_revision_queued',
          payload: { bookId: 'b-1', revisionId: 'revision-1' },
        }),
      ]);
      const queueService = createMockQueueService();
      const dispatcher = new OutboxDispatcherService(outboxService as never, queueService as never);

      await dispatcher.sweep();

      expect(queueService.enqueuePageImageRevision).toHaveBeenCalledWith({
        kind: 'page_image_revision',
        bookId: 'b-1',
        revisionId: 'revision-1',
      });
      expect(queueService.enqueue).not.toHaveBeenCalled();
      expect(outboxService.markDispatched).toHaveBeenCalledWith('event-1');
    });

    it('dispatches a durable hard-delete request without private payload data', async () => {
      const outboxService = createMockOutboxService([
        makeEvent({
          aggregateType: 'book_deletion',
          aggregateId: 'deletion-1',
          eventType: 'book_deletion_requested',
          payload: { bookId: 'b-1', deletionRequestId: 'deletion-1' },
        }),
      ]);
      const queueService = createMockQueueService();
      const dispatcher = new OutboxDispatcherService(outboxService as never, queueService as never);

      await dispatcher.sweep();

      expect(queueService.enqueueBookDeletion).toHaveBeenCalledWith({
        kind: 'book_deletion',
        bookId: 'b-1',
        deletionRequestId: 'deletion-1',
      });
      expect(queueService.enqueue).not.toHaveBeenCalled();
      expect(queueService.enqueuePageImageRevision).not.toHaveBeenCalled();
      expect(outboxService.markDispatched).toHaveBeenCalledWith('event-1');
    });

    it('records an attempt failure (and does not mark dispatched) when the queue publish fails, without aborting the rest of the batch', async () => {
      const outboxService = createMockOutboxService([
        makeEvent({
          id: 'event-1',
          aggregateId: 'run-1',
          payload: { bookId: 'b-1', runId: 'run-1' },
        }),
        makeEvent({
          id: 'event-2',
          aggregateId: 'run-2',
          payload: { bookId: 'b-2', runId: 'run-2' },
        }),
      ]);
      const queueService = createMockQueueService();
      queueService.enqueue.mockRejectedValueOnce(new Error('Redis connection refused'));
      const dispatcher = new OutboxDispatcherService(outboxService as never, queueService as never);

      await dispatcher.sweep();

      expect(outboxService.recordAttemptFailure).toHaveBeenCalledWith('event-1');
      expect(outboxService.markDispatched).not.toHaveBeenCalledWith('event-1');
      // The second event in the batch still gets processed.
      expect(outboxService.markDispatched).toHaveBeenCalledWith('event-2');
    });

    it('skips (never dispatches, never marks) an event with an unknown aggregateType', async () => {
      const outboxService = createMockOutboxService([
        makeEvent({ aggregateType: 'something_else' }),
      ]);
      const queueService = createMockQueueService();
      const dispatcher = new OutboxDispatcherService(outboxService as never, queueService as never);

      await dispatcher.sweep();

      expect(queueService.enqueue).not.toHaveBeenCalled();
      expect(outboxService.markDispatched).not.toHaveBeenCalled();
    });

    it('skips a malformed payload (missing bookId/runId) without throwing', async () => {
      const outboxService = createMockOutboxService([makeEvent({ payload: { nonsense: true } })]);
      const queueService = createMockQueueService();
      const dispatcher = new OutboxDispatcherService(outboxService as never, queueService as never);

      await expect(dispatcher.sweep()).resolves.toBeUndefined();
      expect(queueService.enqueue).not.toHaveBeenCalled();
    });

    it('does not start a second sweep while one is still in flight', async () => {
      let resolveFindPending!: (events: OutboxEvent[]) => void;
      const outboxService = {
        findPending: vi
          .fn()
          .mockReturnValue(new Promise((resolve) => (resolveFindPending = resolve))),
        markDispatched: vi.fn(),
        recordAttemptFailure: vi.fn(),
      } as unknown as jest.Mocked<OutboxService>;
      const queueService = createMockQueueService();
      const dispatcher = new OutboxDispatcherService(outboxService as never, queueService as never);

      const first = dispatcher.sweep();
      const second = dispatcher.sweep();
      resolveFindPending([]);
      await Promise.all([first, second]);

      expect(outboxService.findPending).toHaveBeenCalledTimes(1);
    });
  });
});
