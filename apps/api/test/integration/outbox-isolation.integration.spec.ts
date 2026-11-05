import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../src/database/prisma.service';
import { GenerationQueueService } from '../../src/agent/generation-queue.service';
import { OutboxDispatcherService } from '../../src/outbox/outbox-dispatcher.service';
import { OutboxService } from '../../src/outbox/outbox.service';

describe('outbox batch isolation (real PostgreSQL + Redis)', () => {
  const prisma = new PrismaService();
  const eventIds: string[] = [];
  const outbox = new OutboxService(prisma);
  let queue: Queue;

  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());
  beforeEach(async () => {
    vi.stubEnv('OUTBOX_DISPATCH_BATCH_SIZE', '20');
    queue = new Queue(`test-outbox-isolation-${randomUUID()}`, {
      connection: { url: process.env['REDIS_URL']!, maxRetriesPerRequest: null },
    });
    await queue.waitUntilReady();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    try {
      await prisma.outboxEvent.deleteMany({ where: { id: { in: eventIds } } });
      eventIds.length = 0;
      await queue.obliterate({ force: true });
    } finally {
      await queue.close();
    }
  });

  async function createEvent(overrides: Partial<Prisma.OutboxEventCreateInput> = {}) {
    const id = randomUUID();
    const runId = randomUUID();
    eventIds.push(id);
    return prisma.outboxEvent.create({
      data: {
        id,
        aggregateType: 'generation_run',
        aggregateId: runId,
        eventType: 'run_queued',
        payload: { bookId: randomUUID(), runId },
        createdAt: new Date(0),
        nextAttemptAt: new Date(0),
        ...overrides,
      },
    });
  }

  it('quarantines a full poison batch and dispatches newer work after a dispatcher restart', async () => {
    const poison = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        createEvent(
          index % 4 === 0
            ? { aggregateType: 'unknown-private-content' }
            : index % 4 === 1
              ? { payload: Prisma.JsonNull }
              : index % 4 === 2
                ? { payload: [] }
                : { payload: { bookId: randomUUID(), runId: randomUUID() } },
        ),
      ),
    );
    const healthy = await createEvent({ createdAt: new Date(1), nextAttemptAt: new Date(1) });
    await new OutboxDispatcherService(outbox, new GenerationQueueService(queue)).sweep();

    expect(
      await prisma.outboxEvent.count({
        where: { id: { in: poison.map((event) => event.id) }, status: 'quarantined' },
      }),
    ).toBe(20);
    expect(await queue.getJobCounts('waiting')).toMatchObject({ waiting: 0 });
    const quarantined = await prisma.outboxEvent.findMany({
      where: { id: { in: poison.map((event) => event.id) } },
    });
    expect(quarantined.every((event) => event.quarantinedAt && !event.dispatchedAt)).toBe(true);
    expect(new Set(quarantined.map((event) => event.lastFailureCode))).toEqual(
      new Set(['unknown_aggregate', 'invalid_payload']),
    );

    // A new instance uses persisted state, without an in-memory skip list.
    await new OutboxDispatcherService(
      new OutboxService(prisma),
      new GenerationQueueService(queue),
    ).sweep();
    expect(await prisma.outboxEvent.findUniqueOrThrow({ where: { id: healthy.id } })).toMatchObject(
      {
        status: 'dispatched',
      },
    );
    expect(await queue.getJobCounts('waiting')).toMatchObject({ waiting: 1 });
    expect(await queue.getJob(healthy.aggregateId)).not.toBeNull();
  });

  it('backs off a full failed batch so newer work can reach Redis', async () => {
    const failing = await Promise.all(Array.from({ length: 20 }, () => createEvent()));
    const healthy = await createEvent({ createdAt: new Date(1), nextAttemptAt: new Date(1) });
    const queueService = new GenerationQueueService(queue);
    const publish = vi
      .spyOn(queueService, 'enqueue')
      .mockRejectedValue(new Error('Redis unavailable'));
    const before = new Date();
    await new OutboxDispatcherService(outbox, queueService).sweep();
    const failed = await prisma.outboxEvent.findMany({
      where: { id: { in: failing.map((e) => e.id) } },
    });
    expect(
      failed.every(
        (e) =>
          e.status === 'pending' &&
          e.attempts === 1 &&
          e.lastFailureCode === 'dispatch_failed' &&
          e.nextAttemptAt.getTime() >= before.getTime() + 2000,
      ),
    ).toBe(true);
    // Query eligibility at a fixed instant, avoiding a wall-clock sleep.
    expect((await outbox.findPending(20, before)).map((e) => e.id)).toContain(healthy.id);
    expect(
      (await outbox.findPending(20, before)).some((e) => failing.some((f) => f.id === e.id)),
    ).toBe(false);
    // Hold retries in the future even on a heavily paused test host.
    await prisma.outboxEvent.updateMany({
      where: { id: { in: failing.map((e) => e.id) } },
      data: { nextAttemptAt: new Date(Date.now() + 60_000) },
    });
    publish.mockRestore();
    await new OutboxDispatcherService(new OutboxService(prisma), queueService).sweep();
    expect(await queue.getJob(healthy.aggregateId)).not.toBeNull();
    expect(await prisma.outboxEvent.findUniqueOrThrow({ where: { id: healthy.id } })).toMatchObject(
      { status: 'dispatched' },
    );
  });

  it('counts concurrent failures once per observed attempt version', async () => {
    const event = await createEvent();
    const now = new Date();
    const results = await Promise.all([
      outbox.recordAttemptFailure(event.id, 0, now),
      new OutboxService(prisma).recordAttemptFailure(event.id, 0, now),
    ]);
    expect(results.map((result) => result.count).sort()).toEqual([0, 1]);
    expect(await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      attempts: 1,
      nextAttemptAt: new Date(now.getTime() + 2000),
    });
    expect(await outbox.recordAttemptFailure(event.id, 0)).toEqual({ count: 0 });
    expect(await outbox.recordAttemptFailure(event.id, 1, now)).toEqual({ count: 1 });
    expect(await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      attempts: 2,
      nextAttemptAt: new Date(now.getTime() + 4000),
    });
  });

  it.each(['cancelled', 'dispatched', 'quarantined'])(
    'preserves terminal %s against stale sweep writes',
    async (status) => {
      const event = await createEvent({ status });
      expect(await outbox.markDispatched(event.id)).toEqual({ count: 0 });
      expect(await outbox.recordAttemptFailure(event.id, 0)).toEqual({ count: 0 });
      expect(await outbox.quarantine(event.id, 'invalid_payload')).toEqual({ count: 0 });
      expect(await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toEqual(
        event,
      );
    },
  );
});
