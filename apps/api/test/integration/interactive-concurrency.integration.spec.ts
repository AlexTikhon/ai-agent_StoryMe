import { HttpException } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service';
import { InteractiveService } from '../../src/interactive/interactive.service';
import type { PublicSessionView } from '../../src/interactive/public-view';
import { Barrier, InteractiveTestKit, configWithCap } from './fixtures/interactive-helpers';

type Settled = { ok: true; view: PublicSessionView } | { ok: false; code: string | undefined };

async function settle(promise: Promise<PublicSessionView>): Promise<Settled> {
  try {
    return { ok: true, view: await promise };
  } catch (error) {
    if (error instanceof HttpException) {
      return { ok: false, code: (error.getResponse() as { code?: string }).code };
    }
    throw error;
  }
}

/**
 * Concurrency is driven by a barrier inside the narrator rather than sleeps:
 * every racing request finishes preparing (outside any transaction) at the same
 * base revision, and only then are all of them released into the commit path
 * together, so they genuinely contend for the session row lock.
 */
describe('Interactive engine concurrency (real Postgres)', () => {
  const kit = new InteractiveTestKit();

  beforeAll(() => kit.connect());
  afterAll(() => kit.disconnect());
  afterEach(async () => {
    kit.narrator.barrier = null;
    await kit.cleanup();
  });

  it('lets exactly one of two competing different-key requests transition', async () => {
    const userId = await kit.createUser();
    const start = await kit.start(userId);
    kit.narrator.barrier = new Barrier(2);

    const results = await Promise.all([
      settle(
        kit.service.submitChoice(userId, start.sessionId, {
          choiceId: 'c-ask-caretaker',
          expectedRevision: 0,
          idempotencyKey: 'race-key-a',
        }),
      ),
      settle(
        kit.service.submitChoice(userId, start.sessionId, {
          choiceId: 'c-read-mailboxes',
          expectedRevision: 0,
          idempotencyKey: 'race-key-b',
        }),
      ),
    ]);

    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toEqual([{ ok: false, code: 'REVISION_CONFLICT' }]);
    expect(await kit.eventCount(start.sessionId)).toBe(2);
    await kit.assertReplayMatchesStored(start.sessionId);

    // The loser's key was not consumed; it can be retried at the new revision.
    const winner = (successes[0] as Extract<Settled, { ok: true }>).view;
    expect(winner.revision).toBe(1);
  });

  it('serializes many different-key racers into a single transition', async () => {
    const userId = await kit.createUser();
    const start = await kit.start(userId);
    const racers = 6;
    kit.narrator.barrier = new Barrier(racers);

    const results = await Promise.all(
      Array.from({ length: racers }, (_, i) =>
        settle(
          kit.service.submitChoice(userId, start.sessionId, {
            choiceId: i % 2 === 0 ? 'c-ask-caretaker' : 'c-read-mailboxes',
            expectedRevision: 0,
            idempotencyKey: `many-key-${i}`,
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === 'REVISION_CONFLICT')).toBe(
      true,
    );
    expect(await kit.eventCount(start.sessionId)).toBe(2);
    await kit.assertReplayMatchesStored(start.sessionId);
  });

  it('produces one event and equal responses for two concurrent identical requests', async () => {
    const userId = await kit.createUser();
    const start = await kit.start(userId);
    kit.narrator.barrier = new Barrier(2);
    const command = {
      choiceId: 'c-ask-caretaker',
      expectedRevision: 0,
      idempotencyKey: 'same-key-1',
    };

    // A second service with its own connection pool models a second API process.
    const otherPrisma = new PrismaService();
    await otherPrisma.$connect();
    const second = new InteractiveService(otherPrisma, kit.narrator, configWithCap(50));
    let results: Settled[];
    try {
      results = await Promise.all([
        settle(kit.service.submitChoice(userId, start.sessionId, command)),
        settle(second.submitChoice(userId, start.sessionId, command)),
      ]);
    } finally {
      await otherPrisma.$disconnect();
    }

    expect(results.every((r) => r.ok)).toBe(true);
    const [a, b] = results as Extract<Settled, { ok: true }>[];
    expect(a.view).toEqual(b.view);
    expect(a.view.revision).toBe(1);
    expect(await kit.eventCount(start.sessionId)).toBe(2);
    await kit.assertReplayMatchesStored(start.sessionId);
  });

  it('keeps concurrent sessions of one user independent', async () => {
    const userId = await kit.createUser();
    const a = await kit.start(userId);
    const b = await kit.start(userId);
    kit.narrator.barrier = new Barrier(2);

    const [ra, rb] = await Promise.all([
      settle(
        kit.service.submitChoice(userId, a.sessionId, {
          choiceId: 'c-ask-caretaker',
          expectedRevision: 0,
          idempotencyKey: 'indep-key-1',
        }),
      ),
      settle(
        kit.service.submitChoice(userId, b.sessionId, {
          choiceId: 'c-read-mailboxes',
          expectedRevision: 0,
          idempotencyKey: 'indep-key-1',
        }),
      ),
    ]);
    expect(ra.ok && rb.ok).toBe(true);
    await kit.assertReplayMatchesStored(a.sessionId);
    await kit.assertReplayMatchesStored(b.sessionId);
  });

  it('re-prepares narration when the session catches up to the requested revision mid-request', async () => {
    const userId = await kit.createUser();
    const start = await kit.start(userId);

    // Request X asks for revision 1 while the session is still at revision 0, so its
    // first read skips narration. A gate holds X after that read until Y has committed.
    let releaseX!: () => void;
    const gate = new Promise<void>((resolve) => (releaseX = resolve));
    let pausedOnce = false;
    const prisma = kit.prisma;
    const slowPrisma = new Proxy(prisma, {
      get(target, prop) {
        if (prop === 'interactiveSession') {
          return new Proxy(target.interactiveSession, {
            get(delegate, method) {
              const value = Reflect.get(delegate, method, delegate) as (
                ...args: unknown[]
              ) => Promise<unknown>;
              if (method !== 'findFirst') return value.bind(delegate);
              return async (...args: unknown[]) => {
                const row = await value.apply(delegate, args);
                if (!pausedOnce) {
                  pausedOnce = true;
                  await gate;
                }
                return row;
              };
            },
          });
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const serviceX = new InteractiveService(slowPrisma, kit.narrator, configWithCap(50));

    const pendingX = settle(
      serviceX.submitChoice(userId, start.sessionId, {
        choiceId: 'c-climb-from-caretaker',
        expectedRevision: 1,
        idempotencyKey: 'catchup-key-x',
      }),
    );
    // Y advances the session 0 -> 1 while X is paused.
    const y = await kit.choose(userId, start, 'c-ask-caretaker', 'catchup-key-y');
    expect(y.revision).toBe(1);
    const callsBeforeRelease = kit.narrator.calls;
    releaseX();

    const x = await pendingX;
    expect(x.ok).toBe(true);
    expect((x as Extract<Settled, { ok: true }>).view).toMatchObject({
      revision: 2,
      scene: { id: 's-door' },
    });
    // X needed a second, properly bound narration after the stale first attempt.
    expect(kit.narrator.calls).toBeGreaterThan(callsBeforeRelease);
    expect(await kit.eventCount(start.sessionId)).toBe(3);
    await kit.assertReplayMatchesStored(start.sessionId);
  });
});
