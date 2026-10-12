import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import type { InteractiveTranscriptDto } from '@book/types';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InteractiveService } from '../../src/interactive/interactive.service';
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

/** A service over the real database that records every sessionEvent.findMany argument. */
function recordingService(kit: InteractiveTestKit) {
  const findManyCalls: unknown[] = [];
  const prisma = new Proxy(kit.prisma, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop !== 'sessionEvent') {
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      }
      return new Proxy(value as object, {
        get(delegate, method) {
          const original = Reflect.get(delegate, method, delegate) as (...a: unknown[]) => unknown;
          if (method !== 'findMany') return original.bind(delegate);
          return (args: unknown) => {
            findManyCalls.push(args);
            return original.call(delegate, args);
          };
        },
      });
    },
  }) as PrismaService;
  return {
    findManyCalls,
    service: new InteractiveService(prisma, kit.narrator, configWithCap(50)),
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

describe('Interactive transcript (real Postgres)', () => {
  const kit = new InteractiveTestKit();

  beforeAll(() => kit.connect());
  afterAll(() => kit.disconnect());
  afterEach(() => kit.cleanup());

  const query = (raw: Record<string, string> = {}) => parseRequest(transcriptQuerySchema, raw);

  /** Plays a route to its end; returns every stored view, genesis first. */
  async function complete(userId: string, route: readonly string[]) {
    let view = await kit.start(userId);
    const views: PublicSessionView[] = [view];
    for (const choiceId of route) {
      view = await kit.choose(userId, view, choiceId);
      views.push(view);
    }
    return { sessionId: view.sessionId, views };
  }

  async function walk(userId: string, sessionId: string, limit: number) {
    const pages: InteractiveTranscriptDto[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 40; guard += 1) {
      const page = await kit.service.getTranscript(
        userId,
        sessionId,
        query({ limit: String(limit), ...(cursor ? { cursor } : {}) }),
      );
      pages.push(page);
      if (!page.nextCursor) return pages;
      cursor = page.nextCursor;
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
    'reproduces the %s path exactly as the player saw it',
    async (name) => {
      const route = WARSAW_ROUTES[name];
      const userId = await kit.createUser();
      const { sessionId, views } = await complete(userId, route);

      const transcript = await kit.service.getTranscript(userId, sessionId, query());

      expect(transcript).toMatchObject({
        sessionId,
        scenarioId: 'warsaw-last-delivery',
        scenarioVersion: 1,
        completedRevision: route.length,
        nextCursor: null,
      });
      expect(transcript.steps).toHaveLength(route.length + 1);
      for (const [i, step] of transcript.steps.entries()) {
        expect(step.revision).toBe(i);
        expect(step.scene).toEqual(views[i]!.scene);
        expect(step.narration).toBe(views[i]!.narration);
        expect(step.arrivedByChoiceLabel).toBe(
          i === 0 ? null : views[i - 1]!.choices.find((c) => c.id === route[i - 1])!.label,
        );
        expect(step.ending).toEqual(
          i === route.length
            ? { title: views[i]!.ending!.title, summary: views[i]!.ending!.summary }
            : null,
        );
      }
      expect(Object.keys(transcript).sort()).toEqual(
        [
          'completedRevision',
          'nextCursor',
          'scenarioId',
          'scenarioVersion',
          'sessionId',
          'steps',
        ].sort(),
      );
      const text = JSON.stringify(transcript);
      for (const leaked of [
        'stateHash',
        'payload',
        'idempotency',
        'requestHash',
        'flags',
        'npcKnowledge',
        'fromSceneId',
        'choices',
      ]) {
        expect(text).not.toContain(leaked);
      }
    },
  );

  it('gives the same steps whatever the page size, with labels derived across page boundaries', async () => {
    const userId = await kit.createUser();
    const { sessionId } = await complete(userId, WARSAW_ROUTES.exposed);
    const whole = (await walk(userId, sessionId, 25))[0]!.steps;
    expect(whole).toHaveLength(6);

    for (const limit of [1, 2, 3, 5, 6, 7]) {
      const pages = await walk(userId, sessionId, limit);
      expect(
        pages.flatMap((p) => p.steps),
        `limit ${limit}`,
      ).toEqual(whole);
      for (const page of pages.slice(0, -1)) expect(page.steps).toHaveLength(limit);
      expect(pages.at(-1)!.nextCursor).toBeNull();
    }
    // A boundary-aligned final page ends cleanly with no empty trailing page.
    expect(await walk(userId, sessionId, 3)).toHaveLength(2);
    expect(await walk(userId, sessionId, 6)).toHaveLength(1);
  });

  it('reads only the requested page plus its predecessor, and no other event', async () => {
    const userId = await kit.createUser();
    const { sessionId } = await complete(userId, WARSAW_ROUTES.exposed);
    const first = await kit.service.getTranscript(userId, sessionId, query({ limit: '2' }));
    const { service, findManyCalls } = recordingService(kit);

    const second = await service.getTranscript(
      userId,
      sessionId,
      query({ limit: '2', cursor: first.nextCursor! }),
    );

    expect(second.steps.map((s) => s.revision)).toEqual([2, 3]);
    expect(findManyCalls).toHaveLength(1);
    expect(findManyCalls[0]).toMatchObject({ where: { sessionId, seq: { gte: 1, lte: 3 } } });
    const selected = (findManyCalls[0] as { select: Record<string, boolean> }).select;
    expect(Object.keys(selected).sort()).toEqual(
      ['payload', 'response', 'schemaVersion', 'seq', 'type'].sort(),
    );
  });

  it('is read-only, never narrates and leaves original idempotent responses intact', async () => {
    const userId = await kit.createUser();
    const created = await kit.start(userId, 'transcript-create-key');
    const choiceKey = 'transcript-choice-key';
    let view = await kit.choose(userId, created, WARSAW_ROUTES.quietAtDoor[0], choiceKey);
    const firstChoice = view;
    for (const choiceId of WARSAW_ROUTES.quietAtDoor.slice(1)) {
      view = await kit.choose(userId, view, choiceId);
    }
    const before = await snapshot(created.sessionId);
    const narrations = kit.narrator.calls;

    await walk(userId, created.sessionId, 1);
    await walk(userId, created.sessionId, 25);

    expect(await snapshot(created.sessionId)).toBe(before);
    expect(kit.narrator.calls).toBe(narrations);
    expect(await kit.start(userId, 'transcript-create-key')).toEqual(created);
    expect(
      await kit.service.submitChoice(userId, created.sessionId, {
        choiceId: WARSAW_ROUTES.quietAtDoor[0],
        expectedRevision: 0,
        idempotencyKey: choiceKey,
      }),
    ).toEqual(firstChoice);
    expect(await kit.service.getSession(userId, created.sessionId)).toEqual(view);
    await kit.assertReplayMatchesStored(created.sessionId);
  });

  it('does not consult the scenario registry or narrator', async () => {
    const userId = await kit.createUser();
    const { sessionId } = await complete(userId, WARSAW_ROUTES.quietAtDoor);
    const forbidden = () => {
      throw new Error('registry must not be used by the transcript');
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
    const transcript = await service.getTranscript(userId, sessionId, query());
    expect(transcript.steps).toHaveLength(4);
  });

  it('answers missing and foreign sessions identically', async () => {
    const [ownerId, intruderId] = [await kit.createUser(), await kit.createUser()];
    const { sessionId } = await complete(ownerId, WARSAW_ROUTES.quietAtDoor);

    const capture = async (id: string, user: string) => {
      try {
        await kit.service.getTranscript(user, id, query());
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
    const { service, findManyCalls } = recordingService(kit);

    expect(await failureCode(service.getTranscript(userId, running.sessionId, query()))).toBe(
      'SESSION_NOT_COMPLETED',
    );
    const cursor = encodeTranscriptCursor({
      sessionId: running.sessionId,
      completedRevision: 3,
      nextRevision: 2,
    });
    expect(
      await failureCode(service.getTranscript(userId, running.sessionId, query({ cursor }))),
    ).toBe('SESSION_NOT_COMPLETED');
    expect(findManyCalls).toHaveLength(0);
  });

  it('rejects cursors issued for another session or another terminal revision', async () => {
    const userId = await kit.createUser();
    const a = await complete(userId, WARSAW_ROUTES.exposed);
    const b = await complete(userId, WARSAW_ROUTES.exposed);
    const fromA = (await kit.service.getTranscript(userId, a.sessionId, query({ limit: '2' })))
      .nextCursor!;

    expect(
      await failureCode(kit.service.getTranscript(userId, b.sessionId, query({ cursor: fromA }))),
    ).toBe('INVALID_REQUEST');
    const wrongTerminal = encodeTranscriptCursor({
      sessionId: a.sessionId,
      completedRevision: 4,
      nextRevision: 2,
    });
    expect(
      await failureCode(
        kit.service.getTranscript(userId, a.sessionId, query({ cursor: wrongTerminal })),
      ),
    ).toBe('INVALID_REQUEST');
  });

  describe('corrupt stored data', () => {
    async function ended() {
      const userId = await kit.createUser();
      const { sessionId } = await complete(userId, WARSAW_ROUTES.quietAtDoor); // seq 0..3
      return { userId, sessionId };
    }
    const code = (userId: string, sessionId: string, raw: Record<string, string> = {}) =>
      failureCode(kit.service.getTranscript(userId, sessionId, query(raw)));

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
        where: { sessionId_seq: { sessionId: other.sessionId, seq: 1 } },
      });
      await kit.prisma.sessionEvent.update({
        where: { sessionId_seq: { sessionId, seq: 1 } },
        data: { response: foreignEvent.response as object },
      });
      expect(await code(userId, sessionId)).toBe('SESSION_STATE_INVALID');
    });

    it('fails on a choice that the previous stored view never offered', async () => {
      const { userId, sessionId } = await ended();
      await kit.prisma.sessionEvent.update({
        where: { sessionId_seq: { sessionId, seq: 2 } },
        data: { payload: { choiceId: 'c-never-offered', fromSceneId: 'whatever' } },
      });
      expect(await code(userId, sessionId)).toBe('SESSION_STATE_INVALID');
    });

    it('fails on a malformed stored response or event type', async () => {
      const { userId, sessionId } = await ended();
      await kit.prisma.sessionEvent.update({
        where: { sessionId_seq: { sessionId, seq: 1 } },
        data: { type: 'Mystery' },
      });
      expect(await code(userId, sessionId)).toBe('SESSION_STATE_INVALID');
      await kit.prisma.sessionEvent.update({
        where: { sessionId_seq: { sessionId, seq: 1 } },
        data: { type: 'ChoiceMade', response: { narration: 'only this' } },
      });
      expect(await code(userId, sessionId)).toBe('SESSION_STATE_INVALID');
    });

    it('still reports a corrupt terminal event as invalid, not as in progress', async () => {
      const { userId, sessionId } = await ended();
      await kit.prisma.sessionEvent.update({
        where: { sessionId_seq: { sessionId, seq: 3 } },
        data: { response: { broken: true } },
      });
      expect(await code(userId, sessionId)).toBe('SESSION_STATE_INVALID');
    });
  });
});
