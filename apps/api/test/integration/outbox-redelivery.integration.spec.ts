import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { PrismaService } from '../../src/database/prisma.service';
import { GenerationQueueService } from '../../src/agent/generation-queue.service';
import { OutboxDispatcherService } from '../../src/outbox/outbox-dispatcher.service';
import { OutboxService } from '../../src/outbox/outbox.service';

const REDIS_URL = process.env['REDIS_URL']!;

describe('outbox retry and duplicate BullMQ publication (real PostgreSQL + Redis)', () => {
  const prisma = new PrismaService();
  const eventIds: string[] = [];
  let queue: Queue | undefined;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    if (eventIds.length > 0) {
      await prisma.outboxEvent.deleteMany({ where: { id: { in: eventIds } } });
      eventIds.length = 0;
    }
    if (queue) {
      await queue.obliterate({ force: true });
      await queue.close();
      queue = undefined;
    }
  });

  it('retries an event left pending after publish, while runId job identity prevents duplicate work', async () => {
    const bookId = randomUUID();
    const runId = randomUUID();
    const event = await prisma.outboxEvent.create({
      data: {
        aggregateType: 'generation_run',
        aggregateId: runId,
        eventType: 'generation.requested',
        payload: { bookId, runId },
      },
    });
    eventIds.push(event.id);

    queue = new Queue(`test-outbox-redelivery-${randomUUID()}`, {
      connection: { url: REDIS_URL, maxRetriesPerRequest: null },
    });
    await queue.waitUntilReady();
    const realOutbox = new OutboxService(prisma);
    let failMarkOnce = true;
    const interruptedOutbox = {
      findPending: (limit: number) => realOutbox.findPending(limit),
      recordAttemptFailure: (id: string) => realOutbox.recordAttemptFailure(id),
      markDispatched: (id: string) => {
        if (failMarkOnce) {
          failMarkOnce = false;
          throw new Error('simulated crash after BullMQ publish');
        }
        return realOutbox.markDispatched(id);
      },
    } as OutboxService;
    const dispatcher = new OutboxDispatcherService(
      interruptedOutbox,
      new GenerationQueueService(queue),
    );

    await dispatcher.sweep();
    const afterInterruptedPublish = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(afterInterruptedPublish).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await queue.getJob(runId)).not.toBeNull();

    await dispatcher.sweep();
    await dispatcher.sweep();

    const afterRetry = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
    expect(afterRetry).toMatchObject({ status: 'dispatched', attempts: 1 });
    expect(afterRetry.dispatchedAt).not.toBeNull();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: runId, data: { bookId, runId } });
  });
});
