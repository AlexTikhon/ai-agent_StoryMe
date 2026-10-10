import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { canonicalHash } from '../../src/interactive/domain/canonical';
import { InteractiveService } from '../../src/interactive/interactive.service';
import {
  Barrier,
  InteractiveTestKit,
  configWithCap,
  startCommand,
} from './fixtures/interactive-helpers';
import {
  REAL_ID,
  SECOND_ID,
  openingTitle,
  registryMissingV1Metadata,
  twoStoryRegistry,
  unrelatedRegistry,
} from './fixtures/scenario-variants';

async function failureCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      return (error.getResponse() as { code?: string }).code;
    }
    throw error;
  }
  return undefined;
}

describe('Version-aware session creation and catalogue titles (real Postgres)', () => {
  const kit = new InteractiveTestKit();
  const registry = twoStoryRegistry();
  const multi = new InteractiveService(kit.prisma, kit.narrator, configWithCap(50), registry);

  beforeAll(() => kit.connect());
  afterAll(() => kit.disconnect());
  afterEach(() => {
    kit.narrator.barrier = null;
    return kit.cleanup();
  });

  const create = (userId: string, scenarioId: string, key: string, scenarioVersion?: number) =>
    multi.createSession(userId, {
      scenarioId,
      idempotencyKey: key,
      ...(scenarioVersion === undefined ? {} : { scenarioVersion }),
    });
  const counts = async (userId: string) => ({
    sessions: await kit.prisma.interactiveSession.count({ where: { userId } }),
    events: await kit.prisma.sessionEvent.count({ where: { session: { userId } } }),
  });

  it('starts exactly the explicit version even when a newer one is published', async () => {
    const userId = await kit.createUser();
    const view = await create(userId, REAL_ID, 'explicit-v1-key', 1);

    expect(view).toMatchObject({ scenarioId: REAL_ID, scenarioVersion: 1 });
    expect(view.scene.title).toBe(openingTitle(REAL_ID, 1));
    const row = await kit.prisma.interactiveSession.findUniqueOrThrow({
      where: { id: view.sessionId },
    });
    expect(row.scenarioVersion).toBe(1);
    expect(row.creationRequestHash).toBe(
      canonicalHash({ scenarioId: REAL_ID, scenarioVersion: 1 }),
    );
  });

  it('starts the latest version when the request names none, with the legacy fingerprint', async () => {
    const userId = await kit.createUser();
    const view = await create(userId, REAL_ID, 'omitted-version-key');

    expect(view.scenarioVersion).toBe(2);
    expect(view.scene.title).toBe(openingTitle(REAL_ID, 2));
    const row = await kit.prisma.interactiveSession.findUniqueOrThrow({
      where: { id: view.sessionId },
    });
    expect(row.creationRequestHash).toBe(canonicalHash({ scenarioId: REAL_ID }));
  });

  it('starts the selected story of two catalogue entries', async () => {
    const userId = await kit.createUser();
    const second = await create(userId, SECOND_ID, 'second-story-key', 1);
    const first = await create(userId, REAL_ID, 'first-story-key', 2);

    expect(second).toMatchObject({ scenarioId: SECOND_ID, scenarioVersion: 1 });
    expect(second.scene.title).toBe(openingTitle(SECOND_ID, 1));
    expect(first).toMatchObject({ scenarioId: REAL_ID, scenarioVersion: 2 });
    expect(first.scene.title).toBe(openingTitle(REAL_ID, 2));
  });

  it('rejects unknown ids and versions with a controlled error and writes nothing', async () => {
    const userId = await kit.createUser();
    for (const [id, version] of [
      ['warsaw-last-tram', undefined], // REVIEW_REQUIRED, never registered
      ['warsaw-last-tram', 1],
      ['no-such-story', 1],
      [REAL_ID, 3],
      [REAL_ID, 999],
      [SECOND_ID, 2],
    ] as const) {
      expect(await failureCode(create(userId, id, `reject-${randomUUID()}`, version))).toBe(
        'UNKNOWN_SCENARIO',
      );
    }
    expect(await counts(userId)).toEqual({ sessions: 0, events: 0 });
  });

  it('rejects the unpublished Last Tram on the real registry too', async () => {
    const userId = await kit.createUser();
    for (const version of [undefined, 1]) {
      expect(
        await failureCode(
          kit.service.createSession(userId, {
            ...startCommand('warsaw-last-tram', `tram-${randomUUID()}`),
            ...(version === undefined ? {} : { scenarioVersion: version }),
          }),
        ),
      ).toBe('UNKNOWN_SCENARIO');
    }
    expect(await counts(userId)).toEqual({ sessions: 0, events: 0 });
  });

  it('replays an identical explicit-version retry as the original genesis, without narrating', async () => {
    const userId = await kit.createUser();
    const created = await create(userId, REAL_ID, 'retry-key', 1);
    await multi.submitChoice(userId, created.sessionId, {
      choiceId: 'c-ask-caretaker',
      expectedRevision: 0,
      idempotencyKey: 'advance-key-1',
    });
    const narrationCalls = kit.narrator.calls;

    expect(await create(userId, REAL_ID, 'retry-key', 1)).toEqual(created);
    expect(kit.narrator.calls).toBe(narrationCalls);
    expect(await counts(userId)).toEqual({ sessions: 1, events: 2 });
  });

  it('resolves an existing creation before looking at the registry', async () => {
    const userId = await kit.createUser();
    const created = await create(userId, REAL_ID, 'identity-first-key', 1);
    // A service whose registry no longer knows the story must still replay it.
    const emptied = new InteractiveService(
      kit.prisma,
      kit.narrator,
      configWithCap(50),
      unrelatedRegistry(),
    );
    expect(
      await emptied.createSession(userId, {
        scenarioId: REAL_ID,
        scenarioVersion: 1,
        idempotencyKey: 'identity-first-key',
      }),
    ).toEqual(created);
  });

  it('rejects reuse of a key with another version, and with an explicit version after omission', async () => {
    const userId = await kit.createUser();
    const created = await create(userId, REAL_ID, 'versioned-key', 1);

    expect(await failureCode(create(userId, REAL_ID, 'versioned-key', 2))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(await failureCode(create(userId, REAL_ID, 'versioned-key'))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(await failureCode(create(userId, SECOND_ID, 'versioned-key', 1))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(await create(userId, REAL_ID, 'versioned-key', 1)).toEqual(created);
    expect(await counts(userId)).toEqual({ sessions: 1, events: 1 });

    const legacy = await create(userId, REAL_ID, 'legacy-key');
    expect(await failureCode(create(userId, REAL_ID, 'legacy-key', legacy.scenarioVersion))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('keeps replaying a legacy omitted-version key after a newer version appears', async () => {
    const userId = await kit.createUser();
    // Created before versions existed: a { scenarioId } fingerprint, pinned to v1.
    const legacyId = await kit.seedLegacySession(userId);
    await kit.prisma.interactiveSession.update({
      where: { id: legacyId },
      data: {
        creationIdempotencyKey: 'legacy-existing-key',
        creationRequestHash: canonicalHash({ scenarioId: REAL_ID }),
      },
    });
    const genesis = await kit.prisma.sessionEvent.findUniqueOrThrow({
      where: { sessionId_seq: { sessionId: legacyId, seq: 0 } },
    });

    const replay = await create(userId, REAL_ID, 'legacy-existing-key');

    expect(replay).toEqual(genesis.response);
    expect(replay.scenarioVersion).toBe(1); // not silently upgraded to v2
    expect(await counts(userId)).toEqual({ sessions: 1, events: 1 });
  });

  it('collapses concurrent identical explicit-version commands into one session and genesis', async () => {
    const userId = await kit.createUser();
    const parties = 6;
    kit.narrator.barrier = new Barrier(parties);
    const racing = kit.gatedService(
      { model: 'interactiveSession', method: 'findUnique' },
      parties,
      registry,
    );
    const views = await Promise.all(
      Array.from({ length: parties }, () =>
        racing.createSession(userId, {
          scenarioId: REAL_ID,
          scenarioVersion: 1,
          idempotencyKey: 'concurrent-v1',
        }),
      ),
    );
    expect(new Set(views.map((v) => v.sessionId)).size).toBe(1);
    for (const view of views) expect(view).toEqual(views[0]);
    expect(views[0]!.scenarioVersion).toBe(1);
    expect(await counts(userId)).toEqual({ sessions: 1, events: 1 });
  });

  it('titles sessions from their pinned version and never rewrites stored responses', async () => {
    const userId = await kit.createUser();
    const v1 = await create(userId, REAL_ID, 'title-v1', 1);
    const v2 = await create(userId, REAL_ID, 'title-v2', 2);
    const other = await create(userId, SECOND_ID, 'title-other', 1);
    const legacyId = await kit.seedLegacySession(userId);
    const storedBefore = await kit.prisma.sessionEvent.findMany({
      where: { session: { userId } },
      orderBy: [{ sessionId: 'asc' }, { seq: 'asc' }],
    });

    const { sessions } = await multi.listSessions(userId, { limit: 20, cursor: null });
    const titleOf = (id: string) => sessions.find((s) => s.sessionId === id)?.scenarioTitle;
    expect(titleOf(v1.sessionId)).toBe(`Title ${REAL_ID} v1`);
    expect(titleOf(v2.sessionId)).toBe(`Title ${REAL_ID} v2`);
    expect(titleOf(other.sessionId)).toBe(`Title ${SECOND_ID} v1`);
    expect(titleOf(legacyId)).toBe(`Title ${REAL_ID} v1`);
    for (const session of sessions) {
      expect(session.scenarioVersion).toBe(session.sessionId === v2.sessionId ? 2 : 1);
    }

    const storedAfter = await kit.prisma.sessionEvent.findMany({
      where: { session: { userId } },
      orderBy: [{ sessionId: 'asc' }, { seq: 'asc' }],
    });
    expect(storedAfter).toEqual(storedBefore);
  });

  it('falls back to a generic title when a pinned version has no metadata', async () => {
    const userId = await kit.createUser();
    const created = await create(userId, REAL_ID, 'fallback-title', 1);
    const sparse = new InteractiveService(
      kit.prisma,
      kit.narrator,
      configWithCap(50),
      registryMissingV1Metadata(),
    );
    const { sessions } = await sparse.listSessions(userId, { limit: 20, cursor: null });
    expect(sessions.find((s) => s.sessionId === created.sessionId)?.scenarioTitle).toBe(
      'Interactive story',
    );
  });

  it('keeps an existing session on its pinned version when choosing', async () => {
    const userId = await kit.createUser();
    const created = await create(userId, REAL_ID, 'pinned-key', 1);
    const next = await multi.submitChoice(userId, created.sessionId, {
      choiceId: 'c-ask-caretaker',
      expectedRevision: 0,
      idempotencyKey: 'pinned-choice',
    });
    expect(next.scenarioVersion).toBe(1);
    const row = await kit.prisma.interactiveSession.findUniqueOrThrow({
      where: { id: created.sessionId },
    });
    expect(row.scenarioVersion).toBe(1);
  });
});
