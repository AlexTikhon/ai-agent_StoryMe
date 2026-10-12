import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InteractiveService } from '../../src/interactive/interactive.service';
import type { NarrationRequest, NarratorProvider } from '../../src/interactive/narrator/narrator';
import { MockNarratorProvider } from '../../src/interactive/narrator/mock-narrator.provider';
import type { PublicSessionView } from '../../src/interactive/public-view';
import {
  listSessionsQuerySchema,
  parseRequest,
  transcriptQuerySchema,
} from '../../src/interactive/requests';
import { WARSAW_ROUTES } from '../../src/interactive/scenarios/routes';
import {
  InteractiveTestKit,
  SCENARIO_ID,
  configWithCap,
  startCommand,
  withReadHold,
  withRawWriteHold,
  withTransactionHold,
} from './fixtures/interactive-helpers';

const NOT_FOUND = 'SESSION_NOT_FOUND';

// Blocked-backend probes (pg_stat_activity.query holds the parameterised SQL text).
const WAITING_ON_USER_LOCK = '%FROM users%FOR NO KEY UPDATE%';
const WAITING_ON_CHOICE_LOCK = '%FROM interactive_sessions%FOR UPDATE%';
const WAITING_ON_REMOVAL_LOCK = '%FROM interactive_sessions%user_id%FOR UPDATE%';

async function failureCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return (error.getResponse() as { code?: string }).code;
    throw error;
  }
  return undefined;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

/** Narrator that signals when it is reached and then waits, holding a creation after its fast lookup. */
class HoldingNarrator implements NarratorProvider {
  readonly providerName = 'holding-test';
  private readonly delegate = new MockNarratorProvider();
  constructor(
    private readonly reached: () => void,
    private readonly gate: Promise<void>,
  ) {}
  async narrate(request: NarrationRequest): Promise<unknown> {
    this.reached();
    await this.gate;
    return this.delegate.narrate(request);
  }
}

describe('Interactive session soft removal (real Postgres)', () => {
  const kit = new InteractiveTestKit();
  const tight = new InteractiveTestKit(1);
  const capTwo = new InteractiveTestKit(2);

  beforeAll(async () => {
    await Promise.all([kit.connect(), tight.connect(), capTwo.connect()]);
  });
  afterAll(async () => {
    await Promise.all([kit.disconnect(), tight.disconnect(), capTwo.disconnect()]);
  });
  afterEach(async () => {
    await Promise.all([kit.cleanup(), tight.cleanup(), capTwo.cleanup()]);
  });

  const withCap = (cap: number) =>
    new InteractiveService(kit.prisma, kit.narrator, configWithCap(cap));

  const removedAtOf = async (sessionId: string) =>
    (await kit.prisma.interactiveSession.findUniqueOrThrow({ where: { id: sessionId } })).removedAt;
  const rowCount = (userId: string) => kit.prisma.interactiveSession.count({ where: { userId } });
  const activeCount = (userId: string) =>
    kit.prisma.interactiveSession.count({ where: { userId, removedAt: null } });

  async function until(predicate: () => Promise<boolean>, what: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function waitingOn(like: string): Promise<number> {
    const rows = await kit.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE ${like} AND query NOT LIKE '%pg_stat_activity%'`;
    return rows[0]?.n ?? 0;
  }

  /** Every column of the session row except removed_at, plus every event row, as stored text. */
  async function snapshot(sessionId: string) {
    const session = await kit.prisma.$queryRaw<{ doc: string }[]>`
      SELECT (to_jsonb(s) - 'removed_at')::text AS doc
      FROM interactive_sessions s WHERE id = ${sessionId}::uuid`;
    const events = await kit.prisma.$queryRaw<{ doc: string }[]>`
      SELECT to_jsonb(e)::text AS doc
      FROM session_events e WHERE session_id = ${sessionId}::uuid ORDER BY seq`;
    return { session: session.map((r) => r.doc), events: events.map((r) => r.doc) };
  }

  /** Plays a route to its end with a known key on every step; returns the last view. */
  async function complete(userId: string, route: readonly string[]) {
    let view = await kit.start(userId);
    for (const [i, choiceId] of route.entries()) {
      view = await kit.choose(userId, view, choiceId, `route-key-${i}`);
    }
    return view;
  }

  const transcriptQuery = () => parseRequest(transcriptQuerySchema, {});
  const choice = (key: string, expectedRevision = 0) => ({
    choiceId: 'c-ask-caretaker',
    expectedRevision,
    idempotencyKey: key,
  });

  describe('ownership and repeat removal', () => {
    it('removes once, keeps the first timestamp on repeat, and stays additive', async () => {
      const userId = await kit.createUser();
      const view = await kit.start(userId);
      expect(await removedAtOf(view.sessionId)).toBeNull();

      await expect(kit.service.removeSession(userId, view.sessionId)).resolves.toBeUndefined();
      const first = await removedAtOf(view.sessionId);
      expect(first).toBeInstanceOf(Date);

      await expect(kit.service.removeSession(userId, view.sessionId)).resolves.toBeUndefined();
      expect(await removedAtOf(view.sessionId)).toEqual(first);
      expect(await rowCount(userId)).toBe(1);
    });

    it('resolves silently and changes nothing for foreign, missing and unknown-owner ids', async () => {
      const [ownerId, intruderId] = [await kit.createUser(), await kit.createUser()];
      const view = await kit.start(ownerId);
      const before = await snapshot(view.sessionId);

      await expect(kit.service.removeSession(intruderId, view.sessionId)).resolves.toBeUndefined();
      await expect(kit.service.removeSession(ownerId, randomUUID())).resolves.toBeUndefined();
      await expect(
        kit.service.removeSession(randomUUID(), view.sessionId),
      ).resolves.toBeUndefined();

      expect(await removedAtOf(view.sessionId)).toBeNull();
      expect(await snapshot(view.sessionId)).toEqual(before);
      expect(await kit.service.getSession(ownerId, view.sessionId)).toEqual(view);
    });

    it('keeps sessions created before removal existed active, and lets them be removed', async () => {
      const userId = await kit.createUser();
      const legacyId = await kit.seedLegacySession(userId);
      expect(await removedAtOf(legacyId)).toBeNull();
      expect((await kit.service.getSession(userId, legacyId)).sessionId).toBe(legacyId);

      await kit.service.removeSession(userId, legacyId);
      expect(await failureCode(kit.service.getSession(userId, legacyId))).toBe(NOT_FOUND);
      expect(await rowCount(userId)).toBe(1);
    });
  });

  describe.each([
    ['an unfinished story', false],
    ['a finished story', true],
  ])('%s after removal', (_label, finished) => {
    it('is SESSION_NOT_FOUND on every endpoint and leaves stored data byte-identical', async () => {
      const userId = await kit.createUser();
      const other = await kit.start(userId); // a kept session for library assertions
      // Both shapes carry a committed choice under the known key 'route-key-0'.
      const target = finished
        ? await complete(userId, WARSAW_ROUTES.quietAtDoor)
        : await kit.choose(userId, await kit.start(userId), 'c-ask-caretaker', 'route-key-0');
      const sessionId = target.sessionId;

      const listed = await kit.service.listSessions(
        userId,
        parseRequest(listSessionsQuerySchema, {}),
      );
      expect(listed.sessions.map((s) => s.sessionId)).toContain(sessionId);
      const before = await snapshot(sessionId);
      const narratorCalls = kit.narrator.calls;

      await kit.service.removeSession(userId, sessionId);

      const reads: [string, () => Promise<unknown>][] = [
        ['session', () => kit.service.getSession(userId, sessionId)],
        ['presentation', () => kit.service.getPresentation(userId, sessionId, target.revision)],
        ['metadata', () => kit.service.getSessionMetadata(userId, sessionId)],
        ['transcript', () => kit.service.getTranscript(userId, sessionId, transcriptQuery())],
        [
          'transcript presentation',
          () => kit.service.getTranscriptPresentation(userId, sessionId, transcriptQuery()),
        ],
        [
          'fresh choice',
          () => kit.service.submitChoice(userId, sessionId, choice('fresh-key', target.revision)),
        ],
        [
          'idempotent choice replay',
          () => kit.service.submitChoice(userId, sessionId, choice('route-key-0')),
        ],
      ];
      for (const [name, run] of reads) {
        expect(await failureCode(run()), name).toBe(NOT_FOUND);
      }

      const after = await kit.service.listSessions(
        userId,
        parseRequest(listSessionsQuerySchema, {}),
      );
      expect(after.sessions.map((s) => s.sessionId)).not.toContain(sessionId);
      expect(after.sessions.map((s) => s.sessionId)).toContain(other.sessionId);

      expect(await snapshot(sessionId)).toEqual(before);
      expect(await removedAtOf(sessionId)).not.toBeNull();
      expect(kit.narrator.calls).toBe(narratorCalls);
    });
  });

  it('pages the library past removed sessions without skipping or repeating kept ones', async () => {
    const userId = await kit.createUser();
    const views: PublicSessionView[] = [];
    for (let i = 0; i < 5; i += 1) views.push(await kit.start(userId));
    await kit.service.removeSession(userId, views[1]!.sessionId);
    await kit.service.removeSession(userId, views[3]!.sessionId);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await kit.service.listSessions(
        userId,
        parseRequest(listSessionsQuerySchema, { limit: '1', ...(cursor ? { cursor } : {}) }),
      );
      seen.push(...page.sessions.map((s) => s.sessionId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(new Set(seen)).toEqual(
      new Set([views[0]!.sessionId, views[2]!.sessionId, views[4]!.sessionId]),
    );
    expect(seen).toHaveLength(3);
  });

  describe('creation retries', () => {
    it('refuses an exact retry of a removed creation without recreating or narrating', async () => {
      const userId = await kit.createUser();
      const created = await kit.start(userId, 'removed-key');
      await kit.service.removeSession(userId, created.sessionId);
      const before = await snapshot(created.sessionId);
      const calls = kit.narrator.calls;

      expect(await failureCode(kit.start(userId, 'removed-key'))).toBe('SESSION_REMOVED');

      expect(kit.narrator.calls).toBe(calls);
      expect(await rowCount(userId)).toBe(1);
      expect(await removedAtOf(created.sessionId)).not.toBeNull();
      expect(await snapshot(created.sessionId)).toEqual(before);
      expect(await failureCode(kit.service.getSession(userId, created.sessionId))).toBe(NOT_FOUND);
    });

    it('keeps reporting key reuse for a different fingerprint on a removed identity', async () => {
      const userId = await kit.createUser();
      const created = await kit.start(userId, 'removed-key');
      await kit.service.removeSession(userId, created.sessionId);

      const mismatch = {
        scenarioId: SCENARIO_ID,
        scenarioVersion: 1,
        idempotencyKey: 'removed-key',
      };
      expect(await failureCode(kit.service.createSession(userId, mismatch))).toBe(
        'IDEMPOTENCY_KEY_REUSED',
      );
      expect(await rowCount(userId)).toBe(1);
    });

    it('lets a fresh key start a new story, never reviving the removed one', async () => {
      const userId = await kit.createUser();
      const created = await kit.start(userId, 'removed-key');
      await kit.service.removeSession(userId, created.sessionId);

      const fresh = await kit.start(userId, 'fresh-key');
      expect(fresh.sessionId).not.toBe(created.sessionId);
      expect(await removedAtOf(created.sessionId)).not.toBeNull();
      expect(await removedAtOf(fresh.sessionId)).toBeNull();
      expect(await failureCode(kit.start(userId, 'removed-key'))).toBe('SESSION_REMOVED');
    });

    it('still refuses a removed identity at the cap (the identity is resolved before the cap)', async () => {
      const userId = await tight.createUser();
      const created = await tight.start(userId, 'removed-key');
      await tight.service.removeSession(userId, created.sessionId);
      await tight.start(userId, 'fills-the-slot');

      expect(await failureCode(tight.start(userId, 'removed-key'))).toBe('SESSION_REMOVED');
      expect(await failureCode(tight.start(userId, 'another-key'))).toBe('SESSION_LIMIT_REACHED');
    });

    describe.each([
      [
        'an exact retry',
        { scenarioId: SCENARIO_ID, idempotencyKey: 'late-key' },
        'SESSION_REMOVED',
      ],
      [
        'a mismatched retry',
        { scenarioId: SCENARIO_ID, scenarioVersion: 1, idempotencyKey: 'late-key' },
        'IDEMPOTENCY_KEY_REUSED',
      ],
    ])('under the admission lock: %s', (_label, command, expected) => {
      it('is judged against the identity that was removed after the fast lookup missed', async () => {
        const userId = await kit.createUser();
        const reached = deferred();
        const gate = deferred();
        const late = new InteractiveService(
          kit.prisma,
          new HoldingNarrator(reached.resolve, gate.promise),
          configWithCap(50),
        );

        // The late request finds no identity, then waits (outside any transaction) in narration.
        const pending = failureCode(late.createSession(userId, command));
        await reached.promise;

        // Meanwhile the identity is created and removed by someone else.
        const created = await kit.start(userId, 'late-key');
        await kit.service.removeSession(userId, created.sessionId);
        gate.resolve();

        expect(await pending).toBe(expected);
        expect(await rowCount(userId)).toBe(1);
        expect(await kit.eventCount(created.sessionId)).toBe(1);
        expect(await removedAtOf(created.sessionId)).not.toBeNull();
      });
    });
  });

  describe('creation cap', () => {
    it('counts only non-removed sessions and frees a slot per removal', async () => {
      const userId = await capTwo.createUser();
      const a = await capTwo.start(userId);
      await capTwo.start(userId);
      expect(await failureCode(capTwo.start(userId))).toBe('SESSION_LIMIT_REACHED');

      await capTwo.service.removeSession(userId, a.sessionId);
      const c = await capTwo.start(userId);
      expect(await failureCode(capTwo.start(userId))).toBe('SESSION_LIMIT_REACHED');

      expect(await capTwo.prisma.interactiveSession.count({ where: { userId } })).toBe(3);
      const listed = await capTwo.service.listSessions(
        userId,
        parseRequest(listSessionsQuerySchema, {}),
      );
      expect(listed.sessions).toHaveLength(2);
      expect(listed.sessions.map((s) => s.sessionId)).toContain(c.sessionId);
    });

    it('serializes a removal queued behind an in-flight admission that counted first', async () => {
      const userId = await tight.createUser();
      const only = await tight.start(userId);

      // The creation is held right after its count, inside its transaction and holding the
      // owner admission lock, until the removal is provably queued on that same lock.
      const counted = deferred();
      const release = deferred();
      const creator = new InteractiveService(
        withTransactionHold(
          tight.prisma,
          { model: 'interactiveSession', method: 'count' },
          async () => {
            counted.resolve();
            await release.promise;
          },
        ),
        tight.narrator,
        configWithCap(1),
      );
      const creating = failureCode(creator.createSession(userId, startCommand(SCENARIO_ID, 'k-1')));
      await counted.promise;
      const removing = tight.service.removeSession(userId, only.sessionId);
      await until(async () => (await waitingOn(WAITING_ON_USER_LOCK)) >= 1, 'removal to queue');
      release.resolve();

      // It counted the session before the removal could run, so the cap still applies.
      expect(await creating).toBe('SESSION_LIMIT_REACHED');
      await removing;
      expect(await activeCount(userId)).toBe(0);

      const after = await tight.start(userId, 'k-2');
      expect(await activeCount(userId)).toBe(1);
      expect(after.sessionId).not.toBe(only.sessionId);
    });

    it('never lets removal plus a flood of creations exceed the cap', async () => {
      const userId = await tight.createUser();
      const only = await tight.start(userId);
      const results = await Promise.all([
        failureCode(tight.service.removeSession(userId, only.sessionId)),
        ...Array.from({ length: 5 }, (_, i) => failureCode(tight.start(userId, `flood-${i}`))),
      ]);
      const [removal, ...creations] = results;
      expect(removal).toBeUndefined();
      expect(creations.filter((code) => code === undefined).length).toBeLessThanOrEqual(1);
      expect(creations.filter((code) => code !== undefined)).toEqual(
        creations.filter((code) => code === 'SESSION_LIMIT_REACHED'),
      );
      expect(await activeCount(userId)).toBeLessThanOrEqual(1);
      expect(await rowCount(userId)).toBe(
        1 + creations.filter((code) => code === undefined).length,
      );
    });
  });

  describe('choice and removal races', () => {
    it('refuses a choice, a creation and a replay queued behind an uncommitted removal', async () => {
      const userId = await tight.createUser();
      const view = await tight.start(userId);
      const choiceDone = await tight.choose(userId, view, 'c-ask-caretaker', 'early-key');
      const before = await snapshot(choiceDone.sessionId);

      // The removal holds the owner lock and the session row lock, removed_at already
      // written but not committed, until released.
      const held = deferred();
      const release = deferred();
      const remover = new InteractiveService(
        withRawWriteHold(tight.prisma, async () => {
          held.resolve();
          await release.promise;
        }),
        tight.narrator,
        configWithCap(1),
      );
      const removing = remover.removeSession(userId, view.sessionId);
      await held.promise;

      const choosing = failureCode(
        tight.service.submitChoice(userId, view.sessionId, {
          choiceId: 'c-climb-from-caretaker',
          expectedRevision: 1,
          idempotencyKey: 'late-choice',
        }),
      );
      const replaying = failureCode(
        tight.service.submitChoice(userId, view.sessionId, choice('early-key')),
      );
      const creating = tight.start(userId, 'fresh-after-removal');

      await until(
        async () =>
          (await waitingOn(WAITING_ON_CHOICE_LOCK)) >= 2 &&
          (await waitingOn(WAITING_ON_USER_LOCK)) >= 1,
        'choice, replay and creation to queue behind the removal',
      );
      expect(await tight.eventCount(view.sessionId)).toBe(2);

      release.resolve();
      await removing;

      // Not even the idempotent replay of an earlier, committed choice survives removal.
      expect(await choosing).toBe(NOT_FOUND);
      expect(await replaying).toBe(NOT_FOUND);
      const fresh = await creating; // the freed slot is visible once the removal commits
      expect(fresh.sessionId).not.toBe(view.sessionId);
      expect(await tight.eventCount(view.sessionId)).toBe(2);
      expect(await snapshot(view.sessionId)).toEqual(before);
    });

    it('commits a choice that holds the row lock first, then removes without losing the event', async () => {
      const userId = await kit.createUser();
      const view = await kit.start(userId);

      const held = deferred();
      const release = deferred();
      const chooser = new InteractiveService(
        withTransactionHold(kit.prisma, { model: 'sessionEvent', method: 'create' }, async () => {
          held.resolve();
          await release.promise;
        }),
        kit.narrator,
        configWithCap(50),
      );
      const choosing = chooser.submitChoice(userId, view.sessionId, choice('first-key'));
      await held.promise; // event inserted, session row locked, not yet committed

      const removing = kit.service.removeSession(userId, view.sessionId);
      await until(async () => (await waitingOn(WAITING_ON_REMOVAL_LOCK)) >= 1, 'removal to queue');

      release.resolve();
      const advanced = await choosing;
      await removing;

      expect(advanced.revision).toBe(1);
      expect(await kit.eventCount(view.sessionId)).toBe(2);
      expect(await removedAtOf(view.sessionId)).not.toBeNull();
      const stored = await kit.prisma.interactiveSession.findUniqueOrThrow({
        where: { id: view.sessionId },
      });
      expect(stored.revision).toBe(1);
      await kit.assertReplayMatchesStored(view.sessionId);
      expect(
        await failureCode(kit.service.submitChoice(userId, view.sessionId, choice('first-key'))),
      ).toBe(NOT_FOUND);
    });

    it('returns the pre-removal snapshot to reads that overlap a removal, never a corruption error', async () => {
      const userId = await kit.createUser();

      /** Starts a read, removes the session once ownership is resolved, then lets the read finish. */
      const overlapping = async <T>(
        sessionId: string,
        read: (service: InteractiveService) => Promise<T>,
      ): Promise<T> => {
        const held = deferred();
        const release = deferred();
        const reader = new InteractiveService(
          withReadHold(
            kit.prisma,
            { model: 'interactiveSession', method: 'findFirst' },
            async () => {
              held.resolve();
              await release.promise;
            },
          ),
          kit.narrator,
          configWithCap(50),
        );
        const reading = read(reader);
        await held.promise; // ownership resolved; nothing else read yet
        await kit.service.removeSession(userId, sessionId);
        release.resolve();
        return reading;
      };

      const a = await complete(userId, WARSAW_ROUTES.quietAtDoor);
      const viewBefore = await kit.service.getSession(userId, a.sessionId);
      expect(await overlapping(a.sessionId, (s) => s.getSession(userId, a.sessionId))).toEqual(
        viewBefore,
      );
      // Reads that start after the removal committed are not found.
      expect(await failureCode(kit.service.getSession(userId, a.sessionId))).toBe(NOT_FOUND);

      const b = await complete(userId, WARSAW_ROUTES.quietAtDoor);
      const transcriptBefore = await kit.service.getTranscript(
        userId,
        b.sessionId,
        transcriptQuery(),
      );
      expect(transcriptBefore.steps.length).toBeGreaterThan(0);
      expect(
        await overlapping(b.sessionId, (s) =>
          s.getTranscript(userId, b.sessionId, transcriptQuery()),
        ),
      ).toEqual(transcriptBefore);
    });

    it('never appends an event after a removal commits, across repeated unsynchronised races', async () => {
      const userId = await kit.createUser();
      const outcomes = { choiceFirst: 0, removalFirst: 0 };
      for (let round = 0; round < 12; round += 1) {
        const view = await kit.start(userId);
        const [choiceCode, removeCode, readCode] = await Promise.all([
          failureCode(kit.service.submitChoice(userId, view.sessionId, choice(`round-${round}`))),
          failureCode(kit.service.removeSession(userId, view.sessionId)),
          failureCode(kit.service.getSession(userId, view.sessionId)),
        ]);
        expect(removeCode).toBeUndefined();
        expect([undefined, NOT_FOUND]).toContain(choiceCode);
        expect([undefined, NOT_FOUND]).toContain(readCode); // never SESSION_STATE_INVALID

        // Events equal the committed choices: a refused choice left no trace.
        const events = await kit.eventCount(view.sessionId);
        expect(events).toBe(choiceCode === undefined ? 2 : 1);
        if (choiceCode === undefined) outcomes.choiceFirst += 1;
        else outcomes.removalFirst += 1;
        await kit.assertReplayMatchesStored(view.sessionId);

        // After the removal committed nothing more can be appended.
        expect(
          await failureCode(
            kit.service.submitChoice(userId, view.sessionId, choice(`late-${round}`, events - 1)),
          ),
        ).toBe(NOT_FOUND);
        expect(await kit.eventCount(view.sessionId)).toBe(events);
      }
      expect(outcomes.choiceFirst + outcomes.removalFirst).toBe(12);
    });
  });
});
