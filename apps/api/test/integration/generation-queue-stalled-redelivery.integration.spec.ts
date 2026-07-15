import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Queue, Worker, type Job } from 'bullmq';
import { GenerationRunStatus, type Prisma, type Book } from '@prisma/client';
import { PrismaService } from '../../src/database/prisma.service';
import { GenerationRunService } from '../../src/agent/generation-run.service';
import { buildInputSnapshot, hashInputSnapshot } from '../../src/agent/generation-input-snapshot';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Proves the fix for "BullMQ stalled jobs can be redelivered without
 * attemptsMade increasing" (see GenerationRunService.claim's doc comment) end
 * to end, against a real Redis (BullMQ's own stalled-job recovery, not a
 * mock of it) and a real Postgres. Worker A deliberately never renews its
 * lock (`skipLockRenewal`) and sleeps well past both `lockDuration` and
 * `stalledInterval`, so BullMQ's real stalled-checker reassigns the job to
 * Worker B without ever incrementing the job's attemptsMade — confirmed here
 * directly against BullMQ's own moveStalledJobsToWait Lua script behavior,
 * not assumed.
 */
describe('BullMQ stalled-job redelivery — delivery-token fencing (real Redis + real Postgres)', () => {
  const prisma = new PrismaService();
  const generationRunService = new GenerationRunService(prisma);
  const userIds: string[] = [];
  let queue: Queue | undefined;
  let workerA: Worker | undefined;
  let workerB: Worker | undefined;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await Promise.all([workerA?.close(), workerB?.close(), queue?.close()]);
    workerA = undefined;
    workerB = undefined;
    queue = undefined;
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      userIds.length = 0;
    }
  });

  async function createUserAndBook(): Promise<Book> {
    const user = await prisma.user.create({
      data: { email: `stall-redelivery-${randomUUID()}@example.test` },
    });
    userIds.push(user.id);
    return prisma.book.create({
      data: {
        userId: user.id,
        status: 'char_build',
        childName: 'Mia',
        childAge: 5,
        language: 'en',
        theme: 'friendship',
        pageCount: 6,
      },
    });
  }

  it("worker B reclaims a stalled job with unchanged attemptsMade, atomically bumping fencingVersion and replacing the delivery token — and worker A's later DB write (heartbeat) is rejected", async () => {
    const book = await createUserAndBook();
    const snapshot = buildInputSnapshot(book);
    const run = await prisma.generationRun.create({
      data: {
        bookId: book.id,
        userId: book.userId,
        kind: 'initial',
        status: GenerationRunStatus.queued,
        inputSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        inputHash: hashInputSnapshot(snapshot),
      },
    });

    const queueName = `test-stalled-redelivery-${randomUUID()}`;
    const connection = { url: REDIS_URL, maxRetriesPerRequest: null };
    queue = new Queue(queueName, { connection });
    await queue.add('run-generation', { bookId: book.id, runId: run.id }, { jobId: run.id });

    let workerAToken: string | undefined;
    let workerAFencingVersion: number | undefined;
    let workerAAttemptsMadeAtClaim: number | undefined;
    let workerAHeartbeatResult: boolean | undefined;

    let workerBToken: string | undefined;
    let workerBFencingVersion: number | undefined;
    let workerBAttemptsMadeAtClaim: number | undefined;
    const workerBClaimed = createDeferred<void>();

    workerA = new Worker(
      queueName,
      async (job: Job, token?: string) => {
        const claimed = await generationRunService.claim(run.id, token!, 'worker-A', 5_000);
        workerAToken = token;
        workerAFencingVersion = claimed?.fencingVersion;
        workerAAttemptsMadeAtClaim = job.attemptsMade;

        // Simulate a genuine stall: never renew the lock, and stay "busy"
        // well past both lockDuration and stalledInterval below, so
        // BullMQ's own stalled-checker (not a mock) reassigns this job.
        await new Promise((resolve) => setTimeout(resolve, 1_200));

        workerAHeartbeatResult = await generationRunService.heartbeat(
          run.id,
          workerAToken!,
          workerAFencingVersion!,
          5_000,
        );
      },
      { connection, lockDuration: 300, skipLockRenewal: true, stalledInterval: 200 },
    );
    // Worker A's lock is stolen mid-processing by design (that's the whole
    // point of this test) — BullMQ then rejects its attempt to finish the
    // job ("Missing lock ... moveToFinished/moveToFailed") once it wakes
    // up. That's expected corroborating evidence, not a test failure; this
    // just keeps it from becoming an unhandled 'error' event.
    workerA.on('error', () => undefined);

    workerB = new Worker(
      queueName,
      async (job: Job, token?: string) => {
        const claimed = await generationRunService.claim(run.id, token!, 'worker-B', 5_000);
        workerBToken = token;
        workerBFencingVersion = claimed?.fencingVersion;
        workerBAttemptsMadeAtClaim = job.attemptsMade;
        workerBClaimed.resolve();
      },
      { connection, lockDuration: 300, stalledInterval: 200 },
    );

    await workerA.waitUntilReady();
    await workerB.waitUntilReady();

    // Wait for worker B to receive the stalled redelivery.
    await workerBClaimed.promise;
    // Give worker A's still-sleeping processor time to wake up and attempt its (now-stale) heartbeat.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(workerAToken).toBeDefined();
    expect(workerBToken).toBeDefined();
    // (a) worker A started the job; (c) worker B received the same job.
    expect(workerAAttemptsMadeAtClaim).toBeDefined();
    // (c) unchanged attemptsMade — proves this was a stalled redelivery, not a retry.
    expect(workerBAttemptsMadeAtClaim).toBe(workerAAttemptsMadeAtClaim);
    // (d) worker B genuinely reclaims: a fresh token, fencingVersion strictly bumped again.
    expect(workerBToken).not.toBe(workerAToken);
    expect(workerBFencingVersion).toBe((workerAFencingVersion ?? 0) + 1);
    // (e) worker A's later DB write (heartbeat, standing in for any fenced
    // write — applyFencedBookWrite/completeRun use the identical fencing
    // check) is rejected once worker B's claim has superseded it.
    expect(workerAHeartbeatResult).toBe(false);

    const finalRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(finalRun.deliveryToken).toBe(workerBToken);
    expect(finalRun.fencingVersion).toBe(workerBFencingVersion);
  }, 15_000);
});
