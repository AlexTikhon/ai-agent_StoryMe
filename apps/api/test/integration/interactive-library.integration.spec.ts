import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InteractiveService } from '../../src/interactive/interactive.service';
import { listSessionsQuerySchema, parseRequest } from '../../src/interactive/requests';
import { WARSAW_ROUTES } from '../../src/interactive/scenarios/routes';
import {
  Barrier,
  InteractiveTestKit,
  SCENARIO_ID,
  configWithCap,
  startCommand,
  withTransactionFault,
} from './fixtures/interactive-helpers';

function codeOf(reason: unknown): string | undefined {
  return reason instanceof HttpException
    ? (reason.getResponse() as { code?: string }).code
    : undefined;
}

async function failureCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return codeOf(error);
    throw error;
  }
  return undefined;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

describe('Interactive session creation identity (real Postgres)', () => {
  const kit = new InteractiveTestKit();

  beforeAll(() => kit.connect());
  afterAll(() => kit.disconnect());
  afterEach(() => {
    kit.narrator.barrier = null;
    kit.narrator.mode = 'valid';
    return kit.cleanup();
  });

  const sessionCount = (userId: string) =>
    kit.prisma.interactiveSession.count({ where: { userId } });
  const eventTotal = (userId: string) =>
    kit.prisma.sessionEvent.count({ where: { session: { userId } } });

  it('persists the creation identity on the session', async () => {
    const userId = await kit.createUser();
    const view = await kit.start(userId, 'identity-key-1');
    const row = await kit.prisma.interactiveSession.findUniqueOrThrow({
      where: { id: view.sessionId },
    });
    expect(row.creationIdempotencyKey).toBe('identity-key-1');
    expect(row.creationRequestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('collapses concurrent identical creations into one session and one genesis event', async () => {
    const userId = await kit.createUser();
    const parties = 6;
    // Every caller has resolved "no existing creation" and prepared narration
    // before any of them reaches the write transaction, and inside it every one
    // is held right after its identity re-check: only the admission lock stops
    // all of them from inserting.
    kit.narrator.barrier = new Barrier(parties);
    const racing = kit.gatedService({ model: 'interactiveSession', method: 'findUnique' }, parties);
    const views = await Promise.all(
      Array.from({ length: parties }, () =>
        racing.createSession(userId, startCommand(SCENARIO_ID, 'same-key')),
      ),
    );

    expect(new Set(views.map((v) => v.sessionId)).size).toBe(1);
    for (const view of views) expect(view).toEqual(views[0]);
    expect(await sessionCount(userId)).toBe(1);
    expect(await eventTotal(userId)).toBe(1);
    await kit.assertReplayMatchesStored(views[0]!.sessionId);
  });

  it('returns the original creation response after the session advanced, without narrating again', async () => {
    const userId = await kit.createUser();
    const created = await kit.start(userId, 'replay-key');
    const advanced = await kit.choose(userId, created, 'c-ask-caretaker');
    expect(advanced.revision).toBe(1);
    const narrationCalls = kit.narrator.calls;

    const replay = await kit.start(userId, 'replay-key');

    expect(replay).toEqual(created);
    expect(replay.revision).toBe(0);
    expect(kit.narrator.calls).toBe(narrationCalls);
    expect(await sessionCount(userId)).toBe(1);
    expect(await eventTotal(userId)).toBe(2);
    await kit.assertReplayMatchesStored(created.sessionId);
  });

  it('does not depend on the scenario narrator for a replay', async () => {
    const userId = await kit.createUser();
    const created = await kit.start(userId, 'no-narrator-key');
    kit.narrator.mode = 'invalid-text'; // would be rejected if a replay narrated again
    expect(await kit.start(userId, 'no-narrator-key')).toEqual(created);
  });

  it('rejects key reuse with a different command without creating another session', async () => {
    const userId = await kit.createUser();
    const created = await kit.start(userId, 'reuse-key');

    const code = await failureCode(
      kit.service.createSession(userId, startCommand('some-other-scenario', 'reuse-key')),
    );

    expect(code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await sessionCount(userId)).toBe(1);
    expect(await eventTotal(userId)).toBe(1);
    expect(await kit.start(userId, 'reuse-key')).toEqual(created);
  });

  it('keeps identical keys independent across owners', async () => {
    const [first, second] = [await kit.createUser(), await kit.createUser()];
    const a = await kit.start(first, 'shared-key');
    const b = await kit.start(second, 'shared-key');

    expect(a.sessionId).not.toBe(b.sessionId);
    expect(await kit.start(first, 'shared-key')).toEqual(a);
    expect(await kit.start(second, 'shared-key')).toEqual(b);
    expect(await sessionCount(first)).toBe(1);
    expect(await sessionCount(second)).toBe(1);
  });

  it('leaves no partial session, event or reserved key when creation fails', async () => {
    const userId = await kit.createUser();

    // 1. A failed event insert rolls the session insert back.
    const faulty = new InteractiveService(
      withTransactionFault(kit.prisma, { model: 'sessionEvent', method: 'create' }),
      kit.narrator,
      configWithCap(50),
    );
    await expect(
      faulty.createSession(userId, startCommand(SCENARIO_ID, 'fail-key')),
    ).rejects.toThrow('injected write failure');
    // 2. Rejected narration writes nothing.
    kit.narrator.mode = 'invalid-text';
    expect(await failureCode(kit.start(userId, 'fail-key'))).toBe('NARRATION_INVALID');
    kit.narrator.mode = 'valid';
    expect(await sessionCount(userId)).toBe(0);
    expect(await eventTotal(userId)).toBe(0);

    // The key was never reserved: the same key now creates normally.
    const view = await kit.start(userId, 'fail-key');
    expect(view.revision).toBe(0);
    expect(await sessionCount(userId)).toBe(1);
  });

  it('maps an admission lock timeout to a recoverable error and reserves nothing', async () => {
    const userId = await kit.createUser();
    const held = deferred();
    const release = deferred();
    // Another transaction holds the owner's admission lock past lock_timeout.
    const holder = kit.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR NO KEY UPDATE`;
        held.resolve();
        await release.promise;
      },
      { timeout: 20_000 },
    );
    await held.promise;

    const code = await failureCode(kit.start(userId, 'busy-key'));
    release.resolve();
    await holder;

    expect(code).toBe('SESSION_BUSY');
    expect(await sessionCount(userId)).toBe(0);
    expect((await kit.start(userId, 'busy-key')).revision).toBe(0);
  });

  it('keeps sessions with null creation fields readable, listable and replayable', async () => {
    const userId = await kit.createUser();
    const legacyA = await kit.seedLegacySession(userId);
    const legacyB = await kit.seedLegacySession(userId); // two null keys must not collide
    const row = await kit.prisma.interactiveSession.findUniqueOrThrow({ where: { id: legacyA } });
    expect(row.creationIdempotencyKey).toBeNull();
    expect(row.creationRequestHash).toBeNull();

    const read = await kit.service.getSession(userId, legacyA);
    expect(read).toMatchObject({ sessionId: legacyA, revision: 0 });
    const choice = await kit.choose(userId, read, 'c-ask-caretaker');
    expect(choice.revision).toBe(1);

    const page = await kit.service.listSessions(userId, { limit: 20, cursor: null });
    expect(page.sessions.map((s) => s.sessionId).sort()).toEqual([legacyA, legacyB].sort());
    await kit.assertReplayMatchesStored(legacyA);
    await kit.assertReplayMatchesStored(legacyB);
  });
});

describe('Interactive concurrent session cap (real Postgres)', () => {
  const CAP = 3;
  const kit = new InteractiveTestKit(CAP);

  beforeAll(() => kit.connect());
  afterAll(() => kit.disconnect());
  afterEach(() => {
    kit.narrator.barrier = null;
    return kit.cleanup();
  });

  const sessionCount = (userId: string) =>
    kit.prisma.interactiveSession.count({ where: { userId } });

  it('admits exactly one of several concurrent distinct creations at cap minus one', async () => {
    const userId = await kit.createUser();
    const existing = [await kit.start(userId), await kit.start(userId)];
    const attempts = 6;
    kit.narrator.barrier = new Barrier(attempts);
    // Held right after the count: without the admission lock every attempt
    // would see "2 of 3" and insert.
    const racing = kit.gatedService({ model: 'interactiveSession', method: 'count' }, attempts);

    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () => racing.createSession(userId, startCommand())),
    );

    const admitted = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(attempts - 1);
    for (const r of refused)
      expect(codeOf((r as PromiseRejectedResult).reason)).toBe('SESSION_LIMIT_REACHED');
    expect(await sessionCount(userId)).toBe(CAP);
    for (const view of [
      ...existing,
      (admitted[0] as PromiseFulfilledResult<{ sessionId: string }>).value,
    ]) {
      await kit.assertReplayMatchesStored(view.sessionId);
    }
  });

  it('refuses a new creation at the cap but still honours an accepted retry', async () => {
    const userId = await kit.createUser();
    const keys = ['cap-a', 'cap-b', 'cap-c'];
    const views = [];
    for (const key of keys) views.push(await kit.start(userId, key));
    expect(await sessionCount(userId)).toBe(CAP);

    expect(await failureCode(kit.start(userId, 'cap-new'))).toBe('SESSION_LIMIT_REACHED');
    for (const [index, key] of keys.entries()) {
      expect(await kit.start(userId, key)).toEqual(views[index]);
    }
    expect(await sessionCount(userId)).toBe(CAP);
    // A refused creation reserved nothing: it is admitted once room exists.
    await kit.prisma.interactiveSession.delete({ where: { id: views[0]!.sessionId } });
    expect((await kit.start(userId, 'cap-new')).revision).toBe(0);
  });

  it('counts completed sessions and is per owner', async () => {
    const userId = await kit.createUser();
    const otherId = await kit.createUser();
    for (let i = 0; i < CAP; i += 1) {
      let view = await kit.start(userId);
      if (i === 0) {
        for (const choiceId of WARSAW_ROUTES.quietAtDoor)
          view = await kit.choose(userId, view, choiceId);
        expect(view.status).toBe('ended');
      }
    }
    expect(await failureCode(kit.start(userId))).toBe('SESSION_LIMIT_REACHED');
    expect((await kit.start(otherId)).revision).toBe(0);
  });
});

describe('Interactive session library listing (real Postgres)', () => {
  const kit = new InteractiveTestKit();

  beforeAll(() => kit.connect());
  afterAll(() => kit.disconnect());
  afterEach(() => kit.cleanup());

  async function walk(userId: string, limit: number) {
    const pages: string[][] = [];
    let cursorToken: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const query = parseRequest(listSessionsQuerySchema, {
        limit: String(limit),
        ...(cursorToken ? { cursor: cursorToken } : {}),
      });
      const page = await kit.service.listSessions(userId, query);
      pages.push(page.sessions.map((s) => s.sessionId));
      if (!page.nextCursor) return pages;
      cursorToken = page.nextCursor;
    }
    throw new Error('pagination did not terminate');
  }

  it('pages deterministically through equal timestamps without gaps or duplicates', async () => {
    const userId = await kit.createUser();
    const tie = new Date('2026-10-01T12:00:00.000Z');
    const created: Array<{ id: string; createdAt: Date }> = [];
    const stamps = [
      tie,
      tie,
      tie,
      tie,
      new Date('2026-10-02T08:00:00.000Z'),
      new Date('2026-09-30T08:00:00.000Z'),
      tie,
    ];
    for (const createdAt of stamps) {
      created.push({ id: await kit.seedLegacySession(userId, { createdAt }), createdAt });
    }
    const expected = [...created]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      .map((s) => s.id);

    for (const limit of [1, 2, 3, 7, 20]) {
      const pages = await walk(userId, limit);
      expect(pages.flat(), `limit ${limit}`).toEqual(expected);
      for (const page of pages.slice(0, -1)) expect(page).toHaveLength(limit);
    }
  });

  it('never returns another owner’s sessions, even with their cursor', async () => {
    const [ownerId, otherId] = [await kit.createUser(), await kit.createUser()];
    const own = [await kit.start(ownerId), await kit.start(ownerId)];
    const foreign = [await kit.start(otherId), await kit.start(otherId), await kit.start(otherId)];

    const ownList = await kit.service.listSessions(ownerId, { limit: 20, cursor: null });
    expect(ownList.sessions.map((s) => s.sessionId).sort()).toEqual(
      own.map((v) => v.sessionId).sort(),
    );

    const foreignFirst = await kit.service.listSessions(otherId, { limit: 1, cursor: null });
    const crossed = await kit.service.listSessions(ownerId, {
      limit: 20,
      cursor: parseRequest(listSessionsQuerySchema, { cursor: foreignFirst.nextCursor! }).cursor,
    });
    const leaked = new Set(foreign.map((v) => v.sessionId));
    expect(crossed.sessions.every((s) => !leaked.has(s.sessionId))).toBe(true);
    expect(await kit.service.listSessions(randomUUID(), { limit: 5, cursor: null })).toEqual({
      sessions: [],
      nextCursor: null,
    });
  });

  it('summarizes the current scene and ending from the allow-listed view only', async () => {
    const userId = await kit.createUser();
    const active = await kit.choose(userId, await kit.start(userId), 'c-ask-caretaker');
    let done = await kit.start(userId);
    for (const choiceId of WARSAW_ROUTES.quietAtDoor)
      done = await kit.choose(userId, done, choiceId);

    const page = await kit.service.listSessions(userId, { limit: 20, cursor: null });
    const byId = new Map(page.sessions.map((s) => [s.sessionId, s]));

    expect(byId.get(active.sessionId)).toMatchObject({
      scenarioId: SCENARIO_ID,
      scenarioVersion: 1,
      sceneTitle: active.scene.title,
      status: 'in_progress',
      endingTitle: null,
    });
    expect(byId.get(done.sessionId)).toMatchObject({
      status: 'ended',
      sceneTitle: done.scene.title,
      endingTitle: done.ending!.title,
    });
    for (const summary of page.sessions) {
      expect(Object.keys(summary).sort()).toEqual(
        [
          'createdAt',
          'endingTitle',
          'scenarioId',
          'scenarioVersion',
          'sceneTitle',
          'sessionId',
          'status',
          'updatedAt',
        ].sort(),
      );
      expect(new Date(summary.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(summary.createdAt).getTime(),
      );
    }
    const text = JSON.stringify(page);
    for (const leaked of [
      'npcKnowledge',
      'consumedItems',
      'stateHash',
      'payload',
      'idempotency',
      'requestHash',
      'narration',
      'choices',
      'knowledge',
    ]) {
      expect(text).not.toContain(leaked);
    }
    await kit.assertReplayMatchesStored(active.sessionId);
    await kit.assertReplayMatchesStored(done.sessionId);
  });
});
