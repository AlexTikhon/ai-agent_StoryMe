import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import type { InteractiveTranscriptDto, InteractiveTranscriptPresentationDto } from '@book/types';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InteractiveService } from '../../src/interactive/interactive.service';
import { WARSAW_NOIR_V1 } from '../../src/interactive/presentation/presentation';
import type { PublicSessionView } from '../../src/interactive/public-view';
import {
  encodeTranscriptCursor,
  parseRequest,
  transcriptQuerySchema,
} from '../../src/interactive/requests';
import type { ScenarioRegistry } from '../../src/interactive/scenarios';
import { WARSAW_ROUTES } from '../../src/interactive/scenarios/routes';
import type { PrismaService } from '../../src/database/prisma.service';
import { InteractiveTestKit, configWithCap } from './fixtures/interactive-helpers';
import { REAL_ID, SECOND_ID, twoStoryRegistry } from './fixtures/scenario-variants';

const WRITE_METHODS = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  '$executeRaw',
  '$executeRawUnsafe',
  '$transaction',
]);

/**
 * A service over the real database that records every database call it makes,
 * model methods and raw queries alike, as "model.method" / "$method".
 */
function recordingService(kit: InteractiveTestKit, registry?: ScenarioRegistry) {
  const calls: string[] = [];
  const wrap = (target: object, label: string): object =>
    new Proxy(target, {
      get(delegate, method) {
        const value = Reflect.get(delegate, method, delegate) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(`${label}.${String(method)}`);
          return (value as (...a: unknown[]) => unknown).apply(delegate, args);
        };
      },
    });
  const prisma = new Proxy(kit.prisma, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof prop === 'symbol') return value;
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          calls.push(prop);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (value && typeof value === 'object' && !prop.startsWith('$') && !prop.startsWith('_')) {
        return wrap(value, prop);
      }
      return value;
    },
  }) as PrismaService;
  return {
    calls,
    service: new InteractiveService(prisma, kit.narrator, configWithCap(50), registry),
  };
}

async function failureCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return (error.getResponse() as { code?: string }).code;
    throw error;
  }
  return undefined;
}

describe('Interactive transcript artwork (real Postgres)', () => {
  const kit = new InteractiveTestKit();
  const multi = new InteractiveService(
    kit.prisma,
    kit.narrator,
    configWithCap(50),
    twoStoryRegistry(),
  );

  beforeAll(() => kit.connect());
  afterAll(() => kit.disconnect());
  afterEach(() => kit.cleanup());

  const query = (raw: Record<string, string> = {}) => parseRequest(transcriptQuerySchema, raw);
  const artwork = (
    userId: string,
    sessionId: string,
    raw: Record<string, string> = {},
    service: InteractiveService = kit.service,
  ) => service.getTranscriptPresentation(userId, sessionId, query(raw));

  async function complete(userId: string, route: readonly string[]) {
    let view = await kit.start(userId);
    for (const choiceId of route) view = await kit.choose(userId, view, choiceId);
    return view.sessionId;
  }

  /** Walks the artwork pages and the text pages side by side with one cursor chain. */
  async function walkBoth(userId: string, sessionId: string, limit: number) {
    const pairs: Array<{
      text: InteractiveTranscriptDto;
      art: InteractiveTranscriptPresentationDto;
    }> = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 40; guard += 1) {
      const raw = { limit: String(limit), ...(cursor ? { cursor } : {}) };
      const text = await kit.service.getTranscript(userId, sessionId, query(raw));
      const art = await artwork(userId, sessionId, raw);
      pairs.push({ text, art });
      if (!text.nextCursor) return pairs;
      cursor = text.nextCursor;
    }
    throw new Error('pagination did not terminate');
  }

  async function snapshot(sessionId: string) {
    const session = await kit.prisma.interactiveSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    const events = await kit.prisma.sessionEvent.findMany({
      where: { sessionId },
      orderBy: { seq: 'asc' },
    });
    return JSON.stringify({ session, events });
  }

  it.each(['exposed', 'quietAtDoor'] as const)(
    'returns the artwork for every scene of the %s path, aligned with the text transcript',
    async (name) => {
      const route = WARSAW_ROUTES[name];
      const userId = await kit.createUser();
      const sessionId = await complete(userId, route);

      const text = await kit.service.getTranscript(userId, sessionId, query());
      const art = await artwork(userId, sessionId);

      expect(art).toMatchObject({
        sessionId,
        scenarioId: 'warsaw-last-delivery',
        scenarioVersion: 1,
        completedRevision: route.length,
        nextCursor: null,
      });
      expect(art.steps).toHaveLength(route.length + 1);
      expect(art.steps.map((s) => [s.revision, s.sceneId])).toEqual(
        text.steps.map((s) => [s.revision, s.scene.id]),
      );
      for (const step of art.steps) {
        expect(step.presentation).toEqual({
          packId: WARSAW_NOIR_V1.packId,
          packVersion: WARSAW_NOIR_V1.packVersion,
          panels: WARSAW_NOIR_V1.scenes[step.sceneId],
        });
      }
      expect(art.steps.at(-1)!.sceneId).toBe(name === 'exposed' ? 's-end-exposed' : 's-end-quiet');
    },
  );

  it('aligns exactly with the text transcript at every page size, boundaries included', async () => {
    const userId = await kit.createUser();
    const sessionId = await complete(userId, WARSAW_ROUTES.exposed);

    for (const limit of [1, 2, 3, 5, 6, 7, 25]) {
      const pairs = await walkBoth(userId, sessionId, limit);
      for (const { text, art } of pairs) {
        expect(art.steps.map((s) => [s.revision, s.sceneId])).toEqual(
          text.steps.map((s) => [s.revision, s.scene.id]),
        );
        expect(art.nextCursor, `limit ${limit}`).toBe(text.nextCursor);
        expect(art.completedRevision).toBe(text.completedRevision);
        expect(art.sessionId).toBe(text.sessionId);
        expect(art.scenarioId).toBe(text.scenarioId);
        expect(art.scenarioVersion).toBe(text.scenarioVersion);
      }
      expect(pairs.flatMap((p) => p.art.steps.map((s) => s.revision))).toEqual([0, 1, 2, 3, 4, 5]);
    }
    // A boundary-aligned final page ends cleanly with no empty trailing page.
    expect(await walkBoth(userId, sessionId, 3)).toHaveLength(2);
    expect(await walkBoth(userId, sessionId, 6)).toHaveLength(1);
  });

  it('serves a genesis-only page and a mid-path page with the same artwork as the whole walk', async () => {
    const userId = await kit.createUser();
    const sessionId = await complete(userId, WARSAW_ROUTES.exposed);
    const whole = (await artwork(userId, sessionId, { limit: '25' })).steps;

    const first = await artwork(userId, sessionId, { limit: '1' });
    expect(first.steps).toEqual([whole[0]]);
    expect(first.steps[0]).toMatchObject({ revision: 0, sceneId: 's-courtyard' });
    const second = await artwork(userId, sessionId, { limit: '2', cursor: first.nextCursor! });
    expect(second.steps).toEqual(whole.slice(1, 3));
  });

  it('answers missing and foreign sessions identically', async () => {
    const [ownerId, intruderId] = [await kit.createUser(), await kit.createUser()];
    const sessionId = await complete(ownerId, WARSAW_ROUTES.quietAtDoor);

    const capture = async (id: string, user: string) => {
      try {
        await artwork(user, id);
      } catch (error) {
        return (error as HttpException).getResponse();
      }
      throw new Error('expected a failure');
    };
    const missing = await capture(randomUUID(), ownerId);
    const foreign = await capture(sessionId, intruderId);
    expect(foreign).toEqual(missing);
    expect(missing).toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('refuses an in-progress session, with or without a cursor, before reading any step', async () => {
    const userId = await kit.createUser();
    const started = await kit.start(userId);
    const running = await kit.choose(userId, started, WARSAW_ROUTES.quietAtDoor[0]);
    const { service, calls } = recordingService(kit);

    expect(await failureCode(artwork(userId, running.sessionId, {}, service))).toBe(
      'SESSION_NOT_COMPLETED',
    );
    const cursor = encodeTranscriptCursor({
      sessionId: running.sessionId,
      completedRevision: 3,
      nextRevision: 2,
    });
    expect(await failureCode(artwork(userId, running.sessionId, { cursor }, service))).toBe(
      'SESSION_NOT_COMPLETED',
    );
    expect(calls.filter((c) => c.endsWith('.findMany'))).toEqual([]);
  });

  it('rejects cursors issued for another session or another terminal revision', async () => {
    const userId = await kit.createUser();
    const a = await complete(userId, WARSAW_ROUTES.exposed);
    const b = await complete(userId, WARSAW_ROUTES.exposed);
    const fromA = (await artwork(userId, a, { limit: '2' })).nextCursor!;

    expect(await failureCode(artwork(userId, b, { cursor: fromA }))).toBe('INVALID_REQUEST');
    const wrongTerminal = encodeTranscriptCursor({
      sessionId: a,
      completedRevision: 4,
      nextRevision: 2,
    });
    expect(await failureCode(artwork(userId, a, { cursor: wrongTerminal }))).toBe(
      'INVALID_REQUEST',
    );
    // The text transcript's own cursor is accepted unchanged.
    const textCursor = (await kit.service.getTranscript(userId, a, query({ limit: '2' })))
      .nextCursor!;
    expect(textCursor).toBe(fromA);
  });

  describe('pinned scenario versions', () => {
    it('selects artwork by the session pinned identity, and none for versions without a pack', async () => {
      const userId = await kit.createUser();
      const play = async (scenarioId: string, scenarioVersion: number) => {
        let view = await multi.createSession(userId, {
          scenarioId,
          scenarioVersion,
          idempotencyKey: `pin-${randomUUID()}`,
        });
        for (const choiceId of WARSAW_ROUTES.quietAtDoor) {
          view = await multi.submitChoice(userId, view.sessionId, {
            choiceId,
            expectedRevision: view.revision,
            idempotencyKey: `pin-${randomUUID()}`,
          });
        }
        return view.sessionId;
      };
      const v1 = await play(REAL_ID, 1);
      const v2 = await play(REAL_ID, 2);
      const other = await play(SECOND_ID, 1);

      const withArt = await artwork(userId, v1, {}, multi);
      expect(withArt.scenarioVersion).toBe(1);
      expect(withArt.steps.every((s) => s.presentation?.packId === 'warsaw-noir')).toBe(true);

      for (const sessionId of [v2, other]) {
        const page = await artwork(userId, sessionId, {}, multi);
        expect(page.steps).toHaveLength(4);
        expect(page.steps.every((s) => s.presentation === null)).toBe(true);
        expect(page.steps.map((s) => s.sceneId)).toEqual(withArt.steps.map((s) => s.sceneId));
      }
      expect((await artwork(userId, v2, {}, multi)).scenarioVersion).toBe(2);
    });

    it('returns presentation: null for every step when the registry has no pack, never an error', async () => {
      const userId = await kit.createUser();
      const sessionId = await complete(userId, WARSAW_ROUTES.quietAtDoor);
      // Re-pin the stored identity to a version no pack covers; events stay coherent
      // only through the transcript's own identity check, so rewrite them in step.
      const events = await kit.prisma.sessionEvent.findMany({ where: { sessionId } });
      await kit.prisma.interactiveSession.update({
        where: { id: sessionId },
        data: { scenarioVersion: 7 },
      });
      for (const event of events) {
        await kit.prisma.sessionEvent.update({
          where: { sessionId_seq: { sessionId, seq: event.seq } },
          data: {
            response: { ...(event.response as object), scenarioVersion: 7 },
            ...(event.seq === 0
              ? { payload: { ...(event.payload as object), scenarioVersion: 7 } }
              : {}),
          },
        });
      }
      const page = await artwork(userId, sessionId);
      expect(page.scenarioVersion).toBe(7);
      expect(page.steps).toHaveLength(4);
      expect(page.steps.every((s) => s.presentation === null)).toBe(true);
    });
  });

  describe('corrupt stored data', () => {
    async function ended() {
      const userId = await kit.createUser();
      const sessionId = await complete(userId, WARSAW_ROUTES.quietAtDoor); // seq 0..3
      return { userId, sessionId };
    }
    const code = (userId: string, sessionId: string) =>
      failureCode(artwork(userId, sessionId));

    it('fails on a missing event instead of skipping it', async () => {
      const { userId, sessionId } = await ended();
      await kit.prisma.sessionEvent.delete({ where: { sessionId_seq: { sessionId, seq: 2 } } });
      expect(await code(userId, sessionId)).toBe('SESSION_STATE_INVALID');
    });

    it('fails when the terminal event is missing', async () => {
      const { userId, sessionId } = await ended();
      await kit.prisma.sessionEvent.delete({ where: { sessionId_seq: { sessionId, seq: 3 } } });
      expect(await code(userId, sessionId)).toBe('SESSION_STATE_INVALID');
    });

    it('fails on a sequence gap', async () => {
      const { userId, sessionId } = await ended();
      await kit.prisma.sessionEvent.update({
        where: { sessionId_seq: { sessionId, seq: 2 } },
        data: { seq: 7 },
      });
      expect(await code(userId, sessionId)).toBe('SESSION_STATE_INVALID');
    });

    it('fails on a response that belongs to another session or revision', async () => {
      const { userId, sessionId } = await ended();
      const other = await complete(userId, WARSAW_ROUTES.quietAtDoor);
      const foreignEvent = await kit.prisma.sessionEvent.findUniqueOrThrow({
        where: { sessionId_seq: { sessionId: other, seq: 1 } },
      });
      await kit.prisma.sessionEvent.update({
        where: { sessionId_seq: { sessionId, seq: 1 } },
        data: { response: foreignEvent.response as object },
      });
      expect(await code(userId, sessionId)).toBe('SESSION_STATE_INVALID');
    });

    it('fails on a malformed event type or a corrupt terminal response', async () => {
      const { userId, sessionId } = await ended();
      await kit.prisma.sessionEvent.update({
        where: { sessionId_seq: { sessionId, seq: 1 } },
        data: { type: 'Mystery' },
      });
      expect(await code(userId, sessionId)).toBe('SESSION_STATE_INVALID');
      await kit.prisma.sessionEvent.update({
        where: { sessionId_seq: { sessionId, seq: 1 } },
        data: { type: 'ChoiceMade' },
      });
      await kit.prisma.sessionEvent.update({
        where: { sessionId_seq: { sessionId, seq: 3 } },
        data: { response: { broken: true } },
      });
      expect(await code(userId, sessionId)).toBe('SESSION_STATE_INVALID');
    });

    it('fails exactly where the text transcript fails', async () => {
      const { userId, sessionId } = await ended();
      await kit.prisma.sessionEvent.update({
        where: { sessionId_seq: { sessionId, seq: 2 } },
        data: { payload: { choiceId: 'c-never-offered', fromSceneId: 'whatever' } },
      });
      expect(await code(userId, sessionId)).toBe('SESSION_STATE_INVALID');
      expect(await failureCode(kit.service.getTranscript(userId, sessionId, query()))).toBe(
        'SESSION_STATE_INVALID',
      );
    });
  });

  it('exposes only the allow-listed fields and no unvisited scene', async () => {
    const userId = await kit.createUser();
    const sessionId = await complete(userId, WARSAW_ROUTES.quietAtDoor);
    const art = await artwork(userId, sessionId);

    expect(Object.keys(art).sort()).toEqual(
      [
        'completedRevision',
        'nextCursor',
        'scenarioId',
        'scenarioVersion',
        'sessionId',
        'steps',
      ].sort(),
    );
    for (const step of art.steps) {
      expect(Object.keys(step).sort()).toEqual(['presentation', 'revision', 'sceneId']);
      expect(Object.keys(step.presentation!).sort()).toEqual(['packId', 'packVersion', 'panels']);
      for (const panel of step.presentation!.panels) {
        expect(Object.keys(panel).sort()).toEqual(['alt', 'height', 'id', 'src', 'width']);
      }
    }
    const wire = JSON.stringify(art);
    // The route never reached the exposed ending or the cellar.
    for (const unvisited of ['s-end-exposed', 'p-end-exposed', 's-cellar', 'p-cellar']) {
      expect(wire).not.toContain(unvisited);
    }
    for (const leaked of [
      'narration',
      'choices',
      'inventory',
      'stateHash',
      'payload',
      'idempotency',
      'requestHash',
      'flags',
      'npcKnowledge',
      'fromSceneId',
      'manifest',
      'arrivedBy',
      'ending',
    ]) {
      expect(wire).not.toContain(leaked);
    }
  });

  it('reads a bounded page: the same database calls as the text transcript, none per chapter, no writes', async () => {
    const userId = await kit.createUser();
    const sessionId = await complete(userId, WARSAW_ROUTES.exposed);

    const text = recordingService(kit);
    await text.service.getTranscript(userId, sessionId, query({ limit: '25' }));
    const small = recordingService(kit);
    await small.service.getTranscriptPresentation(userId, sessionId, query({ limit: '1' }));
    const large = recordingService(kit);
    await large.service.getTranscriptPresentation(userId, sessionId, query({ limit: '25' }));

    expect(large.calls).toEqual(text.calls);
    expect(small.calls).toEqual(text.calls);
    expect(large.calls.length).toBeLessThanOrEqual(4);
    expect(large.calls.filter((c) => c.endsWith('.findMany'))).toEqual(['sessionEvent.findMany']);
    for (const call of large.calls) {
      expect(WRITE_METHODS.has(call.split('.').at(-1)!), call).toBe(false);
    }
  });

  it('only reads the requested window of events', async () => {
    const userId = await kit.createUser();
    const sessionId = await complete(userId, WARSAW_ROUTES.exposed);
    const first = await artwork(userId, sessionId, { limit: '2' });
    const seen: unknown[] = [];
    const prisma = new Proxy(kit.prisma, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop !== 'sessionEvent') {
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        }
        return new Proxy(value as object, {
          get(delegate, method) {
            const original = Reflect.get(delegate, method, delegate) as (
              ...a: unknown[]
            ) => unknown;
            if (method !== 'findMany') return original.bind(delegate);
            return (args: unknown) => {
              seen.push(args);
              return original.call(delegate, args);
            };
          },
        });
      },
    }) as PrismaService;
    const service = new InteractiveService(prisma, kit.narrator, configWithCap(50));

    const second = await service.getTranscriptPresentation(
      userId,
      sessionId,
      query({ limit: '2', cursor: first.nextCursor! }),
    );

    expect(second.steps.map((s) => s.revision)).toEqual([2, 3]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ where: { sessionId, seq: { gte: 1, lte: 3 } } });
  });

  it('is read-only, never narrates, and leaves the other reads unchanged', async () => {
    const userId = await kit.createUser();
    const created = await kit.start(userId, 'art-create-key');
    let view = created;
    for (const choiceId of WARSAW_ROUTES.quietAtDoor) view = await kit.choose(userId, view, choiceId);
    const sessionId = created.sessionId;

    const textBefore = await kit.service.getTranscript(userId, sessionId, query());
    const currentBefore = await kit.service.getPresentation(userId, sessionId, view.revision);
    const rows = await snapshot(sessionId);
    const narrations = kit.narrator.calls;

    for (const limit of ['1', '3', '25']) await walkBoth(userId, sessionId, Number(limit));

    expect(await snapshot(sessionId)).toBe(rows);
    expect(kit.narrator.calls).toBe(narrations);
    expect(await kit.service.getTranscript(userId, sessionId, query())).toEqual(textBefore);
    expect(await kit.service.getPresentation(userId, sessionId, view.revision)).toEqual(
      currentBefore,
    );
    expect(await kit.start(userId, 'art-create-key')).toEqual(created);
    expect(await kit.service.getSession(userId, sessionId)).toEqual(view);
    // The current-scene endpoint still refuses historical revisions.
    expect(await failureCode(kit.service.getPresentation(userId, sessionId, 1))).toBe(
      'REVISION_CONFLICT',
    );
    await kit.assertReplayMatchesStored(sessionId);
  });

  it('does not consult the scenario registry or narrator', async () => {
    const userId = await kit.createUser();
    const sessionId = await complete(userId, WARSAW_ROUTES.quietAtDoor);
    const forbidden = () => {
      throw new Error('registry must not be used by the artwork transcript');
    };
    const service = new InteractiveService(
      kit.prisma,
      { providerName: 'forbidden', narrate: forbidden },
      configWithCap(50),
      {
        get: forbidden,
        getLatest: forbidden,
        title: forbidden,
        catalogue: forbidden,
      } as unknown as ScenarioRegistry,
    );
    const art = await artwork(userId, sessionId, {}, service);
    expect(art.steps).toHaveLength(4);
    expect(art.steps.every((s) => s.presentation !== null)).toBe(true);
  });

  it('gives the terminal step the same artwork the current-scene endpoint serves for it', async () => {
    const userId = await kit.createUser();
    const sessionId = await complete(userId, WARSAW_ROUTES.quietAtDoor);
    const view: PublicSessionView = await kit.service.getSession(userId, sessionId);
    const art = await artwork(userId, sessionId);
    // The terminal step's artwork matches what the current-scene endpoint serves now.
    const current = await kit.service.getPresentation(userId, sessionId, view.revision);
    expect(art.steps.at(-1)).toEqual({
      revision: view.revision,
      sceneId: current.sceneId,
      presentation: current.presentation,
    });
  });
});
