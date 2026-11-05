import { afterEach, describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { operationalMetrics } from '../observability/operational-metrics';
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
    nextAttemptAt: new Date('2026-01-01'),
    quarantinedAt: null,
    lastFailureCode: null,
    ...overrides,
  };
}

function createMockOutboxService(pending: OutboxEvent[] = []): jest.Mocked<OutboxService> {
  return {
    findPending: vi.fn().mockResolvedValue(pending),
    markDispatched: vi.fn().mockResolvedValue({ count: 1 }),
    recordAttemptFailure: vi.fn().mockResolvedValue(undefined),
    quarantine: vi.fn().mockResolvedValue({ count: 1 }),
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
  afterEach(() => {
    vi.restoreAllMocks();
    operationalMetrics.resetForTests();
  });
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

      expect(outboxService.recordAttemptFailure).toHaveBeenCalledWith('event-1', 0);
      expect(outboxService.markDispatched).not.toHaveBeenCalledWith('event-1');
      // The second event in the batch still gets processed.
      expect(outboxService.markDispatched).toHaveBeenCalledWith('event-2');
    });

    it('quarantines an unknown aggregate without publishing it', async () => {
      const outboxService = createMockOutboxService([
        makeEvent({ aggregateType: 'something_else' }),
      ]);
      const queueService = createMockQueueService();
      const dispatcher = new OutboxDispatcherService(outboxService as never, queueService as never);

      await dispatcher.sweep();

      expect(queueService.enqueue).not.toHaveBeenCalled();
      expect(outboxService.markDispatched).not.toHaveBeenCalled();
      expect(outboxService.quarantine).toHaveBeenCalledWith('event-1', 'unknown_aggregate');
    });

    it('skips a malformed payload (missing bookId/runId) without throwing', async () => {
      const outboxService = createMockOutboxService([makeEvent({ payload: { nonsense: true } })]);
      const queueService = createMockQueueService();
      const dispatcher = new OutboxDispatcherService(outboxService as never, queueService as never);

      await expect(dispatcher.sweep()).resolves.toBeUndefined();
      expect(queueService.enqueue).not.toHaveBeenCalled();
      expect(outboxService.quarantine).toHaveBeenCalledWith('event-1', 'invalid_payload');
    });

    it.each([
      null,
      [],
      'private prompt',
      17,
      true,
      {},
      { bookId: ' ' },
      { bookId: 'b-1', runId: 'wrong-run' },
    ])('isolates invalid JSON payload %j and continues with valid work', async (payload) => {
      const outbox = createMockOutboxService([
        makeEvent({ payload }),
        makeEvent({ id: 'event-2' }),
      ]);
      const queue = createMockQueueService();
      await new OutboxDispatcherService(outbox, queue).sweep();
      expect(outbox.quarantine).toHaveBeenCalledWith('event-1', 'invalid_payload');
      expect(queue.enqueue).toHaveBeenCalledTimes(1);
      expect(outbox.markDispatched).toHaveBeenCalledWith('event-2');
    });

    it('continues after a failed quarantine write and retries that event on the next sweep', async () => {
      const outbox = createMockOutboxService([
        makeEvent({ payload: null }),
        makeEvent({ id: 'event-2' }),
      ]);
      outbox.quarantine.mockRejectedValueOnce(new Error('database unavailable'));
      const queue = createMockQueueService();
      const dispatcher = new OutboxDispatcherService(outbox, queue);
      await dispatcher.sweep();
      expect(outbox.markDispatched).toHaveBeenCalledWith('event-2');
      await dispatcher.sweep();
      expect(outbox.quarantine).toHaveBeenCalledTimes(2);
    });

    it('continues after retry persistence fails and passes the observed attempt version', async () => {
      const outbox = createMockOutboxService([
        makeEvent({ attempts: 7 }),
        makeEvent({ id: 'event-2' }),
      ]);
      outbox.recordAttemptFailure.mockRejectedValueOnce(new Error('database unavailable'));
      const queue = createMockQueueService();
      queue.enqueue.mockRejectedValueOnce(new Error('Redis unavailable'));
      await new OutboxDispatcherService(outbox, queue).sweep();
      expect(outbox.recordAttemptFailure).toHaveBeenCalledWith('event-1', 7);
      expect(outbox.markDispatched).toHaveBeenCalledWith('event-2');
    });

    it('does not log a dispatch acknowledgement when cancellation won the database write', async () => {
      const outbox = createMockOutboxService([makeEvent()]);
      outbox.markDispatched.mockResolvedValue({ count: 0 });
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      await new OutboxDispatcherService(outbox, createMockQueueService()).sweep();
      expect(log).not.toHaveBeenCalled();
      expect(outbox.recordAttemptFailure).not.toHaveBeenCalled();
    });

    it('does not expose corrupt aggregate or payload content in logs or metric labels', async () => {
      const secret = 'private-child-prompt';
      const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const outbox = createMockOutboxService([
        makeEvent({ aggregateType: secret, payload: { secret } }),
        makeEvent({ id: 'event-2', payload: secret }),
      ]);
      await new OutboxDispatcherService(outbox, createMockQueueService()).sweep();
      expect(errorLog).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);
      expect(operationalMetrics.render()).not.toContain(secret);
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
