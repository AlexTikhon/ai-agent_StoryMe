import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthModeGuard } from '../../src/auth/auth-mode.guard';
import type { RequestWithUser } from '../../src/auth/request-with-user';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { PrismaService } from '../../src/database/prisma.service';
import { InteractiveController } from '../../src/interactive/interactive.controller';
import { InteractiveScenariosController } from '../../src/interactive/interactive-scenarios.controller';
import { InteractiveService } from '../../src/interactive/interactive.service';
import { MockNarratorProvider } from '../../src/interactive/narrator/mock-narrator.provider';
import { NARRATOR_PROVIDER } from '../../src/interactive/narrator/narrator';
import { UserRateLimitGuard } from '../../src/rate-limit/user-rate-limit.guard';

interface ApiBody {
  code?: string;
  sessionId: string;
  revision: number;
  [key: string]: unknown;
}

/** Stands in for the real auth strategy: the caller is whichever user the header names. */
class HeaderAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const id = request.headers['x-test-user'];
    if (typeof id !== 'string') return false;
    request.user = await this.prisma.user.findUniqueOrThrow({ where: { id } });
    return true;
  }
}

/**
 * Exercises the real controller, validation and exception filter over HTTP with
 * the same global setup as main.ts (prefix, ValidationPipe, HttpExceptionFilter).
 * Only the auth strategy is substituted; the guards are still applied by the
 * controller (asserted in interactive.controller.spec.ts).
 */
describe('Interactive HTTP endpoints (real Postgres)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  const userIds: string[] = [];
  let sessionCap = 50;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InteractiveController, InteractiveScenariosController],
      providers: [
        PrismaService,
        InteractiveService,
        { provide: ConfigService, useValue: { get: () => sessionCap } },
        { provide: NARRATOR_PROVIDER, useClass: MockNarratorProvider },
      ],
    })
      .overrideGuard(AuthModeGuard)
      .useFactory({
        factory: (p: PrismaService) => new HeaderAuthGuard(p),
        inject: [PrismaService],
      })
      .overrideGuard(UserRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    prisma = app.get(PrismaService);
  });

  afterEach(async () => {
    sessionCap = 50;
    if (userIds.length === 0) return;
    await prisma.interactiveSession.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    userIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  async function newUser(): Promise<string> {
    const user = await prisma.user.create({ data: { email: `http-${randomUUID()}@example.test` } });
    userIds.push(user.id);
    return user.id;
  }

  async function call(
    method: 'GET' | 'POST',
    path: string,
    userId: string | null,
    body?: unknown,
  ): Promise<{ status: number; json: ApiBody; text: string; headers: Headers }> {
    const response = await fetch(`${baseUrl}/api/interactive/sessions${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(userId ? { 'x-test-user': userId } : {}),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      json: (text ? JSON.parse(text) : null) as ApiBody,
      text,
      headers: response.headers,
    };
  }

  const stable = (json: Record<string, unknown>) => {
    const { timestamp: _t, requestId: _r, path: _p, ...rest } = json;
    return rest;
  };

  it('walks create -> read -> choose -> resume over HTTP', async () => {
    const userId = await newUser();
    const created = await call('POST', '', userId, {
      scenarioId: 'warsaw-last-delivery',
      idempotencyKey: 'http-start-0001',
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ revision: 0, status: 'in_progress' });
    const id = created.json.sessionId as string;

    const read = await call('GET', `/${id}`, userId);
    expect(read.status).toBe(200);
    expect(read.json).toEqual(created.json);

    const command = {
      choiceId: 'c-ask-caretaker',
      expectedRevision: 0,
      idempotencyKey: 'http-key-0001',
    };
    const chosen = await call('POST', `/${id}/choices`, userId, command);
    expect(chosen.status).toBe(200);
    expect(chosen.json).toMatchObject({ revision: 1, scene: { id: 's-caretaker' } });

    // Exact retry returns the same body; a changed command with the key is a 409.
    expect((await call('POST', `/${id}/choices`, userId, command)).json).toEqual(chosen.json);
    const reused = await call('POST', `/${id}/choices`, userId, {
      ...command,
      choiceId: 'c-read-mailboxes',
    });
    expect(reused.status).toBe(409);
    expect(reused.json.code).toBe('IDEMPOTENCY_KEY_REUSED');

    expect((await call('GET', `/${id}`, userId)).json).toEqual(chosen.json);
  });

  it('never puts hidden state on the wire', async () => {
    const userId = await newUser();
    const created = await call('POST', '', userId, {
      scenarioId: 'warsaw-last-delivery',
      idempotencyKey: 'http-start-0002',
    });
    for (const text of [created.text]) {
      for (const leaked of [
        'npcKnowledge',
        'consumedItems',
        'flags',
        'stateHash',
        'payload',
        'altering the building',
        'hiding in the cellar',
        'c-confront-ines',
        'userId',
      ]) {
        expect(text).not.toContain(leaked);
      }
    }
  });

  it('returns identical 404s for missing sessions and other users sessions', async () => {
    const ownerId = await newUser();
    const intruderId = await newUser();
    const created = await call('POST', '', ownerId, {
      scenarioId: 'warsaw-last-delivery',
      idempotencyKey: 'http-start-0003',
    });
    const id = created.json.sessionId as string;
    const command = {
      choiceId: 'c-ask-caretaker',
      expectedRevision: 0,
      idempotencyKey: 'http-key-0002',
    };
    await call('POST', `/${id}/choices`, ownerId, command);

    const missing = await call('GET', `/${randomUUID()}`, ownerId);
    expect(missing.status).toBe(404);
    expect(missing.json.code).toBe('SESSION_NOT_FOUND');

    const probes = [
      await call('GET', `/${id}`, intruderId),
      await call('POST', `/${id}/choices`, intruderId, command),
      await call('POST', `/${id}/choices`, intruderId, {
        ...command,
        idempotencyKey: 'http-key-9999',
      }),
    ];
    for (const probe of probes) {
      expect(probe.status).toBe(404);
      expect(stable(probe.json)).toEqual(stable(missing.json));
    }
  });

  describe('presentation endpoint', () => {
    async function startSession(userId: string, key: string): Promise<string> {
      const created = await call('POST', '', userId, {
        scenarioId: 'warsaw-last-delivery',
        idempotencyKey: key,
      });
      return created.json.sessionId as string;
    }

    async function snapshot(sessionId: string): Promise<string> {
      const session = await prisma.interactiveSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      const events = await prisma.sessionEvent.findMany({
        where: { sessionId },
        orderBy: { seq: 'asc' },
      });
      return JSON.stringify({ session, events });
    }

    it('returns the current scene artwork, private and uncacheable', async () => {
      const userId = await newUser();
      const id = await startSession(userId, 'http-pres-0001');

      const first = await call('GET', `/${id}/presentation?expectedRevision=0`, userId);
      expect(first.status).toBe(200);
      expect(first.headers.get('cache-control')).toBe('private, no-store');
      expect(first.json).toMatchObject({
        sessionId: id,
        revision: 0,
        scenarioId: 'warsaw-last-delivery',
        scenarioVersion: 1,
        sceneId: 's-courtyard',
        presentation: { packId: 'warsaw-noir', packVersion: 1 },
      });
      const panels = (first.json.presentation as { panels: Array<Record<string, unknown>> }).panels;
      expect(panels).toHaveLength(1);
      expect(panels[0]).toMatchObject({
        src: '/interactive/warsaw-noir/v1/s-courtyard.svg',
        width: 1200,
        height: 800,
      });
      // No future scenes, state or narration on the wire.
      for (const leaked of [
        's-caretaker',
        's-cellar',
        'flags',
        'stateHash',
        'narration',
        'userId',
      ]) {
        expect(first.text).not.toContain(leaked);
      }

      await call('POST', `/${id}/choices`, userId, {
        choiceId: 'c-ask-caretaker',
        expectedRevision: 0,
        idempotencyKey: 'http-pres-key-0001',
      });
      const second = await call('GET', `/${id}/presentation?expectedRevision=1`, userId);
      expect(second.status).toBe(200);
      expect(second.json).toMatchObject({ revision: 1, sceneId: 's-caretaker' });
    });

    it('rejects any revision other than the current one with REVISION_CONFLICT', async () => {
      const userId = await newUser();
      const id = await startSession(userId, 'http-pres-0002');
      await call('POST', `/${id}/choices`, userId, {
        choiceId: 'c-ask-caretaker',
        expectedRevision: 0,
        idempotencyKey: 'http-pres-key-0002',
      });
      for (const revision of [0, 2, 999]) {
        const response = await call(
          'GET',
          `/${id}/presentation?expectedRevision=${revision}`,
          userId,
        );
        expect(response.status).toBe(409);
        expect(response.json.code).toBe('REVISION_CONFLICT');
        expect(response.text).not.toContain('s-caretaker');
      }
    });

    it('answers missing and foreign sessions with the identical 404', async () => {
      const ownerId = await newUser();
      const intruderId = await newUser();
      const id = await startSession(ownerId, 'http-pres-0003');

      const missing = await call(
        'GET',
        `/${randomUUID()}/presentation?expectedRevision=0`,
        ownerId,
      );
      expect(missing.status).toBe(404);
      expect(missing.json.code).toBe('SESSION_NOT_FOUND');

      // Even with the right revision, and even with a wrong one: no probing.
      for (const revision of [0, 7]) {
        const foreign = await call(
          'GET',
          `/${id}/presentation?expectedRevision=${revision}`,
          intruderId,
        );
        expect(foreign.status).toBe(404);
        expect(stable(foreign.json)).toEqual(stable(missing.json));
        expect(foreign.text).not.toContain('packId');
      }
      expect((await call('GET', `/${id}/presentation?expectedRevision=0`, null)).status).toBe(403);
    });

    it('validates the id and the query strictly', async () => {
      const userId = await newUser();
      const id = await startSession(userId, 'http-pres-0004');
      for (const path of [
        `/not-a-uuid/presentation?expectedRevision=0`,
        `/${id}/presentation`,
        `/${id}/presentation?expectedRevision=`,
        `/${id}/presentation?expectedRevision=-1`,
        `/${id}/presentation?expectedRevision=1.5`,
        `/${id}/presentation?expectedRevision=0&expectedRevision=1`,
        `/${id}/presentation?expectedRevision=0&userId=${randomUUID()}`,
      ]) {
        const response = await call('GET', path, userId);
        expect(response.status, path).toBe(400);
        expect(response.json.code, path).toBe('INVALID_REQUEST');
      }
    });

    it('is read-only: events, revision, state hashes and narration are untouched', async () => {
      const userId = await newUser();
      const id = await startSession(userId, 'http-pres-0005');
      await call('POST', `/${id}/choices`, userId, {
        choiceId: 'c-read-mailboxes',
        expectedRevision: 0,
        idempotencyKey: 'http-pres-key-0005',
      });
      const narrate = vi.spyOn(MockNarratorProvider.prototype, 'narrate');
      const before = await snapshot(id);
      const eventCount = await prisma.sessionEvent.count({ where: { sessionId: id } });

      try {
        for (let i = 0; i < 3; i += 1) {
          expect((await call('GET', `/${id}/presentation?expectedRevision=1`, userId)).status).toBe(
            200,
          );
          expect((await call('GET', `/${id}/presentation?expectedRevision=0`, userId)).status).toBe(
            409,
          );
        }
        expect(narrate).not.toHaveBeenCalled();
      } finally {
        narrate.mockRestore();
      }
      expect(await snapshot(id)).toBe(before);
      expect(await prisma.sessionEvent.count({ where: { sessionId: id } })).toBe(eventCount);
      // Replay and idempotency are unchanged: the same retry still returns the saved answer.
      const retry = await call('POST', `/${id}/choices`, userId, {
        choiceId: 'c-read-mailboxes',
        expectedRevision: 0,
        idempotencyKey: 'http-pres-key-0005',
      });
      expect(retry.status).toBe(200);
      expect(retry.json).toMatchObject({ revision: 1, scene: { id: 's-mailboxes' } });
    });
  });

  describe('session metadata endpoint', () => {
    const start = async (userId: string, key: string) =>
      (
        await call('POST', '', userId, {
          scenarioId: 'warsaw-last-delivery',
          idempotencyKey: key,
        })
      ).json;

    it('returns only the four allowlisted fields, privately and uncacheable', async () => {
      const userId = await newUser();
      const created = await start(userId, 'http-meta-0001');
      const id = created.sessionId;

      const response = await call('GET', `/${id}/metadata`, userId);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.json).toEqual({
        sessionId: id,
        scenarioId: 'warsaw-last-delivery',
        scenarioVersion: 1,
        title: 'The Last Delivery',
      });
      for (const leaked of ['revision', 'scene', 'narration', 'choices', 'userId', 'status']) {
        expect(response.text).not.toContain(leaked);
      }
    });

    it('answers missing and foreign sessions with the identical 404', async () => {
      const ownerId = await newUser();
      const intruderId = await newUser();
      const id = (await start(ownerId, 'http-meta-0002')).sessionId;

      const missing = await call('GET', `/${randomUUID()}/metadata`, ownerId);
      expect(missing.status).toBe(404);
      expect(missing.json.code).toBe('SESSION_NOT_FOUND');
      const foreign = await call('GET', `/${id}/metadata`, intruderId);
      expect(foreign.status).toBe(404);
      expect(stable(foreign.json)).toEqual(stable(missing.json));
      expect(foreign.text).not.toContain('Last Delivery');
      expect((await call('GET', `/${id}/metadata`, null)).status).toBe(403);
    });

    it('rejects a malformed id and any query parameter', async () => {
      const userId = await newUser();
      const id = (await start(userId, 'http-meta-0003')).sessionId;
      for (const path of [
        '/not-a-uuid/metadata',
        `/${id}/metadata?x=1`,
        `/${id}/metadata?userId=${randomUUID()}`,
        `/${id}/metadata?expectedRevision=0`,
      ]) {
        const response = await call('GET', path, userId);
        expect(response.status, path).toBe(400);
        expect(response.json.code, path).toBe('INVALID_REQUEST');
      }
    });

    it('is read-only and leaves historical idempotent responses unchanged', async () => {
      const userId = await newUser();
      const created = await start(userId, 'http-meta-0004');
      const id = created.sessionId;
      const command = {
        choiceId: 'c-ask-caretaker',
        expectedRevision: 0,
        idempotencyKey: 'http-meta-key-0004',
      };
      const chosen = await call('POST', `/${id}/choices`, userId, command);
      const snapshot = async () =>
        JSON.stringify({
          session: await prisma.interactiveSession.findUniqueOrThrow({ where: { id } }),
          events: await prisma.sessionEvent.findMany({
            where: { sessionId: id },
            orderBy: { seq: 'asc' },
          }),
        });
      const before = await snapshot();
      const narrate = vi.spyOn(MockNarratorProvider.prototype, 'narrate');
      try {
        for (let i = 0; i < 3; i += 1) {
          expect((await call('GET', `/${id}/metadata`, userId)).status).toBe(200);
        }
        expect(narrate).not.toHaveBeenCalled();
      } finally {
        narrate.mockRestore();
      }
      expect(await snapshot()).toBe(before);

      const creationRetry = await call('POST', '', userId, {
        scenarioId: 'warsaw-last-delivery',
        idempotencyKey: 'http-meta-0004',
      });
      expect(creationRetry.json).toEqual(created);
      expect((await call('POST', `/${id}/choices`, userId, command)).json).toEqual(chosen.json);
      expect(Object.keys(created)).not.toContain('title');
    });
  });

  describe('transcript endpoint', () => {
    const ROUTE = ['c-ask-caretaker', 'c-climb-from-caretaker', 'c-leave-parcel'];

    async function finished(userId: string, key: string) {
      let view = (
        await call('POST', '', userId, { scenarioId: 'warsaw-last-delivery', idempotencyKey: key })
      ).json;
      const sessionId = view.sessionId;
      for (const [i, choiceId] of ROUTE.entries()) {
        view = (
          await call('POST', `/${sessionId}/choices`, userId, {
            choiceId,
            expectedRevision: view.revision,
            idempotencyKey: `${key}-c${i}`,
          })
        ).json;
      }
      return sessionId;
    }

    it('pages the completed path privately and uncacheable', async () => {
      const userId = await newUser();
      const id = await finished(userId, 'http-tr-0001');

      const first = await call('GET', `/${id}/transcript?limit=3`, userId);
      expect(first.status).toBe(200);
      expect(first.headers.get('cache-control')).toBe('private, no-store');
      const firstBody = first.json as unknown as {
        steps: Array<{ revision: number; arrivedByChoiceLabel: string | null }>;
        nextCursor: string;
        completedRevision: number;
      };
      expect(firstBody.completedRevision).toBe(3);
      expect(firstBody.steps.map((s) => s.revision)).toEqual([0, 1, 2]);
      expect(firstBody.steps[0]!.arrivedByChoiceLabel).toBeNull();
      expect(firstBody.steps[1]!.arrivedByChoiceLabel).toEqual(expect.any(String));

      const second = await call(
        'GET',
        `/${id}/transcript?limit=3&cursor=${firstBody.nextCursor}`,
        userId,
      );
      expect(second.status).toBe(200);
      const secondBody = second.json as unknown as {
        steps: Array<{ revision: number }>;
        nextCursor: null;
      };
      expect(secondBody.steps.map((s) => s.revision)).toEqual([3]);
      expect(secondBody.nextCursor).toBeNull();

      const defaults = await call('GET', `/${id}/transcript`, userId);
      expect((defaults.json as unknown as { steps: unknown[] }).steps).toHaveLength(4);
      for (const leaked of [
        'stateHash',
        'payload',
        'idempotency',
        'requestHash',
        'choices',
        'knowledge',
      ]) {
        expect(defaults.text).not.toContain(leaked);
      }
    });

    it('answers missing and foreign sessions with the identical 404, and unauthenticated with a refusal', async () => {
      const ownerId = await newUser();
      const intruderId = await newUser();
      const id = await finished(ownerId, 'http-tr-0002');

      const missing = await call('GET', `/${randomUUID()}/transcript`, ownerId);
      const foreign = await call('GET', `/${id}/transcript`, intruderId);
      expect(missing.status).toBe(404);
      expect(foreign.status).toBe(404);
      expect(missing.json.code).toBe('SESSION_NOT_FOUND');
      expect(stable(foreign.json)).toEqual(stable(missing.json));
      expect((await call('GET', `/${id}/transcript`, null)).status).toBe(403);
    });

    it('answers an in-progress session with 409 SESSION_NOT_COMPLETED', async () => {
      const userId = await newUser();
      const created = (
        await call('POST', '', userId, {
          scenarioId: 'warsaw-last-delivery',
          idempotencyKey: 'http-tr-0003',
        })
      ).json;
      const response = await call('GET', `/${created.sessionId}/transcript`, userId);
      expect(response.status).toBe(409);
      expect(response.json.code).toBe('SESSION_NOT_COMPLETED');
    });

    it('rejects malformed queries and cross-session cursors with INVALID_REQUEST', async () => {
      const userId = await newUser();
      const a = await finished(userId, 'http-tr-0004');
      const b = await finished(userId, 'http-tr-0005');
      const cursorA = (
        (await call('GET', `/${a}/transcript?limit=1`, userId)).json as unknown as {
          nextCursor: string;
        }
      ).nextCursor;

      for (const bad of [
        'limit=0',
        'limit=26',
        'limit=abc',
        'limit=2&limit=3',
        'cursor=%21%21',
        `cursor=${'a'.repeat(201)}`,
        'userId=someone-else',
        `cursor=${cursorA}&cursor=${cursorA}`,
      ]) {
        const response = await call('GET', `/${a}/transcript?${bad}`, userId);
        expect(response.status, bad).toBe(400);
        expect(response.json.code, bad).toBe('INVALID_REQUEST');
      }
      const crossed = await call('GET', `/${b}/transcript?cursor=${cursorA}`, userId);
      expect(crossed.status).toBe(400);
      expect(crossed.json.code).toBe('INVALID_REQUEST');
      expect((await call('GET', '/not-a-uuid/transcript', userId)).status).toBe(400);
    });

    it('reports corrupt stored history as SESSION_STATE_INVALID without echoing details', async () => {
      const userId = await newUser();
      const id = await finished(userId, 'http-tr-0006');
      await prisma.sessionEvent.delete({ where: { sessionId_seq: { sessionId: id, seq: 1 } } });
      const response = await call('GET', `/${id}/transcript`, userId);
      expect(response.status).toBe(500);
      expect(response.json.code).toBe('SESSION_STATE_INVALID');
    });
  });

  describe('transcript artwork endpoint', () => {
    const ROUTE = ['c-ask-caretaker', 'c-climb-from-caretaker', 'c-leave-parcel'];
    const PATH = '/transcript/presentation';

    async function finished(userId: string, key: string) {
      let view = (
        await call('POST', '', userId, { scenarioId: 'warsaw-last-delivery', idempotencyKey: key })
      ).json;
      const sessionId = view.sessionId;
      for (const [i, choiceId] of ROUTE.entries()) {
        view = (
          await call('POST', `/${sessionId}/choices`, userId, {
            choiceId,
            expectedRevision: view.revision,
            idempotencyKey: `${key}-c${i}`,
          })
        ).json;
      }
      return sessionId;
    }

    it('pages artwork privately and uncacheable, in step with the text transcript', async () => {
      const userId = await newUser();
      const id = await finished(userId, 'http-ar-0001');

      for (const query of ['?limit=3', '', '?limit=1']) {
        const text = await call('GET', `/${id}/transcript${query}`, userId);
        const art = await call('GET', `/${id}${PATH}${query}`, userId);
        expect(art.status, query).toBe(200);
        expect(art.headers.get('cache-control')).toBe('private, no-store');
        const textBody = text.json as unknown as {
          steps: Array<{ revision: number; scene: { id: string } }>;
          nextCursor: string | null;
        };
        const artBody = art.json as unknown as {
          steps: Array<{ revision: number; sceneId: string; presentation: unknown }>;
          nextCursor: string | null;
          completedRevision: number;
        };
        expect(artBody.steps.map((s) => [s.revision, s.sceneId])).toEqual(
          textBody.steps.map((s) => [s.revision, s.scene.id]),
        );
        expect(artBody.nextCursor).toBe(textBody.nextCursor);
        expect(artBody.completedRevision).toBe(3);
        expect(artBody.steps.every((s) => s.presentation !== null)).toBe(true);
      }

      const first = await call('GET', `/${id}${PATH}?limit=3`, userId);
      const cursor = (first.json as unknown as { nextCursor: string }).nextCursor;
      const second = await call('GET', `/${id}${PATH}?limit=3&cursor=${cursor}`, userId);
      expect(second.status).toBe(200);
      expect(
        (second.json as unknown as { steps: Array<{ revision: number }> }).steps.map(
          (s) => s.revision,
        ),
      ).toEqual([3]);
      for (const leaked of ['narration', 'choices', 'stateHash', 'payload', 'idempotency']) {
        expect(first.text).not.toContain(leaked);
      }
    });

    it('answers missing and foreign sessions with the identical 404, and unauthenticated with a refusal', async () => {
      const ownerId = await newUser();
      const intruderId = await newUser();
      const id = await finished(ownerId, 'http-ar-0002');

      const missing = await call('GET', `/${randomUUID()}${PATH}`, ownerId);
      const foreign = await call('GET', `/${id}${PATH}`, intruderId);
      expect(missing.status).toBe(404);
      expect(foreign.status).toBe(404);
      expect(missing.json.code).toBe('SESSION_NOT_FOUND');
      expect(stable(foreign.json)).toEqual(stable(missing.json));
      expect((await call('GET', `/${id}${PATH}`, null)).status).toBe(403);
    });

    it('answers an in-progress session with 409 SESSION_NOT_COMPLETED', async () => {
      const userId = await newUser();
      const created = (
        await call('POST', '', userId, {
          scenarioId: 'warsaw-last-delivery',
          idempotencyKey: 'http-ar-0003',
        })
      ).json;
      const response = await call('GET', `/${created.sessionId}${PATH}`, userId);
      expect(response.status).toBe(409);
      expect(response.json.code).toBe('SESSION_NOT_COMPLETED');
    });

    it('rejects malformed or repeated queries and cross-session cursors with INVALID_REQUEST', async () => {
      const userId = await newUser();
      const a = await finished(userId, 'http-ar-0004');
      const b = await finished(userId, 'http-ar-0005');
      const cursorA = (
        (await call('GET', `/${a}${PATH}?limit=1`, userId)).json as unknown as {
          nextCursor: string;
        }
      ).nextCursor;

      for (const bad of [
        'limit=0',
        'limit=26',
        'limit=abc',
        'limit=2&limit=3',
        'cursor=%21%21',
        `cursor=${'a'.repeat(201)}`,
        'userId=someone-else',
        `cursor=${cursorA}&cursor=${cursorA}`,
      ]) {
        const response = await call('GET', `/${a}${PATH}?${bad}`, userId);
        expect(response.status, bad).toBe(400);
        expect(response.json.code, bad).toBe('INVALID_REQUEST');
      }
      const crossed = await call('GET', `/${b}${PATH}?cursor=${cursorA}`, userId);
      expect(crossed.status).toBe(400);
      expect(crossed.json.code).toBe('INVALID_REQUEST');
      expect((await call('GET', `/not-a-uuid${PATH}`, userId)).status).toBe(400);
    });

    it('reports corrupt stored history as SESSION_STATE_INVALID', async () => {
      const userId = await newUser();
      const id = await finished(userId, 'http-ar-0006');
      await prisma.sessionEvent.delete({ where: { sessionId_seq: { sessionId: id, seq: 1 } } });
      const response = await call('GET', `/${id}${PATH}`, userId);
      expect(response.status).toBe(500);
      expect(response.json.code).toBe('SESSION_STATE_INVALID');
    });

    it('leaves the text transcript and the current-scene presentation endpoints unchanged', async () => {
      const userId = await newUser();
      const id = await finished(userId, 'http-ar-0007');
      const textBefore = (await call('GET', `/${id}/transcript`, userId)).text;
      const currentBefore = (await call('GET', `/${id}/presentation?expectedRevision=3`, userId))
        .text;

      await call('GET', `/${id}${PATH}`, userId);

      expect((await call('GET', `/${id}/transcript`, userId)).text).toBe(textBefore);
      const current = await call('GET', `/${id}/presentation?expectedRevision=3`, userId);
      expect(current.text).toBe(currentBefore);
      const historical = await call('GET', `/${id}/presentation?expectedRevision=1`, userId);
      expect(historical.status).toBe(409);
      expect(historical.json.code).toBe('REVISION_CONFLICT');
    });
  });

  it('answers malformed input with the stable INVALID_REQUEST code', async () => {
    const userId = await newUser();
    const created = await call('POST', '', userId, {
      scenarioId: 'warsaw-last-delivery',
      idempotencyKey: 'http-start-0004',
    });
    const id = created.json.sessionId as string;
    const valid = {
      choiceId: 'c-ask-caretaker',
      expectedRevision: 0,
      idempotencyKey: 'http-key-0003',
    };

    const bad: Array<[string, string, unknown]> = [
      ['POST', '', {}],
      ['POST', '', { scenarioId: 'warsaw-last-delivery' }],
      ['POST', '', { scenarioId: 'warsaw-last-delivery', idempotencyKey: 'has space' }],
      ['GET', '?limit=0', undefined],
      ['GET', '?limit=51', undefined],
      ['GET', '?limit=2&limit=3', undefined],
      ['GET', '?cursor=not-a-cursor', undefined],
      ['GET', '?userId=someone-else', undefined],
      [
        'POST',
        '',
        {
          scenarioId: 'warsaw-last-delivery',
          idempotencyKey: 'http-start-bad1',
          userId: randomUUID(),
        },
      ],
      ['GET', '/not-a-uuid', undefined],
      ['POST', '/not-a-uuid/choices', valid],
      ['POST', `/${id}/choices`, { ...valid, expectedRevision: -1 }],
      ['POST', `/${id}/choices`, { ...valid, expectedRevision: '0' }],
      ['POST', `/${id}/choices`, { ...valid, idempotencyKey: '' }],
      ['POST', `/${id}/choices`, { ...valid, state: { revision: 9 } }],
      ['POST', `/${id}/choices`, { ...valid, events: [] }],
      ['POST', `/${id}/choices`, '{"choiceId":'],
    ];
    for (const [method, path, body] of bad) {
      const result = await call(method as 'GET' | 'POST', path, userId, body);
      expect(result.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
      if (result.json.code !== undefined) expect(result.json.code).toBe('INVALID_REQUEST');
    }
    expect(
      (await call('POST', '', userId, { scenarioId: 'nope', idempotencyKey: 'http-start-nope' }))
        .json.code,
    ).toBe('UNKNOWN_SCENARIO');
    // Nothing was written by any rejected request.
    expect(await prisma.sessionEvent.count({ where: { sessionId: id } })).toBe(1);
  });

  it('answers rule violations with stable codes', async () => {
    const userId = await newUser();
    const created = await call('POST', '', userId, {
      scenarioId: 'warsaw-last-delivery',
      idempotencyKey: 'http-start-0005',
    });
    const id = created.json.sessionId as string;
    const post = (choiceId: string, expectedRevision: number, key: string) =>
      call('POST', `/${id}/choices`, userId, { choiceId, expectedRevision, idempotencyKey: key });

    expect((await post('c-invented', 0, 'rule-key-0001')).json).toMatchObject({
      code: 'UNKNOWN_CHOICE',
    });
    expect((await post('c-ask-caretaker', 3, 'rule-key-0002')).json).toMatchObject({
      code: 'REVISION_CONFLICT',
    });

    let revision = 0;
    for (const choiceId of ['c-ask-caretaker', 'c-climb-from-caretaker', 'c-leave-parcel']) {
      const step = await post(choiceId, revision, `rule-key-${revision}-ok`);
      expect(step.status).toBe(200);
      revision = step.json.revision;
    }
    const after = await post('c-ask-caretaker', revision, 'rule-key-0003');
    expect(after.status).toBe(409);
    expect(after.json.code).toBe('SESSION_TERMINAL');
    expect(JSON.stringify(after.json)).not.toMatch(/prisma|sql|stack/i);
  });

  it('replays an identical creation and rejects key reuse over HTTP', async () => {
    const userId = await newUser();
    const body = { scenarioId: 'warsaw-last-delivery', idempotencyKey: 'http-replay-0001' };
    const first = await call('POST', '', userId, body);
    expect(first.status).toBe(201);
    const id = first.json.sessionId;
    await call('POST', `/${id}/choices`, userId, {
      choiceId: 'c-ask-caretaker',
      expectedRevision: 0,
      idempotencyKey: 'http-choice-0001',
    });

    const replay = await call('POST', '', userId, body);
    expect(replay.status).toBe(201);
    expect(replay.json).toEqual(first.json); // the genesis response, not the current scene

    const reused = await call('POST', '', userId, { ...body, scenarioId: 'other-scenario' });
    expect(reused.status).toBe(409);
    expect(reused.json.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await prisma.interactiveSession.count({ where: { userId } })).toBe(1);
  });

  describe('scenario catalogue and version-aware creation', () => {
    const catalogue = async (userId: string | null) => {
      const response = await fetch(`${baseUrl}/api/interactive/scenarios`, {
        headers: userId ? { 'x-test-user': userId } : {},
      });
      const text = await response.text();
      return { status: response.status, text, headers: response.headers };
    };

    it('requires authentication', async () => {
      expect([401, 403]).toContain((await catalogue(null)).status);
    });

    it('serves only the allowlisted published entry, privately and uncacheable', async () => {
      const userId = await newUser();
      const response = await catalogue(userId);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(JSON.parse(response.text)).toEqual({
        scenarios: [
          {
            scenarioId: 'warsaw-last-delivery',
            scenarioVersion: 1,
            title: 'The Last Delivery',
            language: 'en',
            synopsis: expect.any(String),
          },
        ],
      });
      for (const leaked of [
        'scenes',
        'choices',
        'endings',
        'entrySceneId',
        'facts',
        'conditions',
        'ledger-exposed',
        'warsaw-last-tram',
        'REVIEW_REQUIRED',
      ]) {
        expect(response.text).not.toContain(leaked);
      }
    });

    it('rejects query parameters on the catalogue', async () => {
      const userId = await newUser();
      const response = await fetch(`${baseUrl}/api/interactive/scenarios?x=1`, {
        headers: { 'x-test-user': userId },
      });
      expect(response.status).toBe(400);
    });

    it('creates the explicit version, replays it, and rejects the same key for another version', async () => {
      const userId = await newUser();
      const body = {
        scenarioId: 'warsaw-last-delivery',
        scenarioVersion: 1,
        idempotencyKey: 'http-version-0001',
      };
      const first = await call('POST', '', userId, body);
      expect(first.status).toBe(201);
      expect(first.json).toMatchObject({ scenarioVersion: 1 });
      expect((await call('POST', '', userId, body)).json).toEqual(first.json);

      const reused = await call('POST', '', userId, { ...body, scenarioVersion: 2 });
      expect(reused.status).toBe(409);
      expect(reused.json.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await prisma.interactiveSession.count({ where: { userId } })).toBe(1);
    });

    it('answers unknown, unpublished and unpublished-version requests with UNKNOWN_SCENARIO', async () => {
      const userId = await newUser();
      let n = 0;
      for (const extra of [
        { scenarioId: 'warsaw-last-tram' },
        { scenarioId: 'warsaw-last-tram', scenarioVersion: 1 },
        { scenarioId: 'warsaw-last-delivery', scenarioVersion: 2 },
      ]) {
        n += 1;
        const response = await call('POST', '', userId, {
          idempotencyKey: `http-unknown-${n}000`,
          ...extra,
        });
        expect(response.status).toBe(422);
        expect(response.json.code).toBe('UNKNOWN_SCENARIO');
      }
      expect(await prisma.interactiveSession.count({ where: { userId } })).toBe(0);
    });

    it('rejects a malformed scenarioVersion as INVALID_REQUEST', async () => {
      const userId = await newUser();
      for (const scenarioVersion of [0, -1, 1.5, '1', null]) {
        const response = await call('POST', '', userId, {
          scenarioId: 'warsaw-last-delivery',
          scenarioVersion,
          idempotencyKey: 'http-bad-version',
        });
        expect(response.status).toBe(400);
        expect(response.json.code).toBe('INVALID_REQUEST');
      }
    });

    it('titles listed sessions from the server', async () => {
      const userId = await newUser();
      await call('POST', '', userId, {
        scenarioId: 'warsaw-last-delivery',
        idempotencyKey: 'http-title-0001',
      });
      const list = (await call('GET', '', userId)).json as unknown as {
        sessions: Array<{ scenarioTitle: string }>;
      };
      expect(list.sessions.map((s) => s.scenarioTitle)).toEqual(['The Last Delivery']);
    });
  });

  it('answers a creation beyond the cap with SESSION_LIMIT_REACHED but still replays', async () => {
    sessionCap = 1;
    const userId = await newUser();
    const body = { scenarioId: 'warsaw-last-delivery', idempotencyKey: 'http-cap-0001' };
    const first = await call('POST', '', userId, body);
    expect(first.status).toBe(201);

    const refused = await call('POST', '', userId, { ...body, idempotencyKey: 'http-cap-0002' });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('SESSION_LIMIT_REACHED');

    expect((await call('POST', '', userId, body)).json).toEqual(first.json);
    expect(await prisma.interactiveSession.count({ where: { userId } })).toBe(1);
  });

  it('lists only the caller’s sessions as allow-listed summaries, with keyset paging', async () => {
    const [ownerId, otherId] = [await newUser(), await newUser()];
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const created = await call('POST', '', ownerId, {
        scenarioId: 'warsaw-last-delivery',
        idempotencyKey: `http-list-${i}000`,
      });
      ids.push(created.json.sessionId);
    }
    await call('POST', '', otherId, {
      scenarioId: 'warsaw-last-delivery',
      idempotencyKey: 'http-list-other',
    });

    const unauthenticated = await call('GET', '', null);
    expect([401, 403]).toContain(unauthenticated.status);

    const first = await call('GET', '?limit=2', ownerId);
    expect(first.status).toBe(200);
    const page1 = first.json as unknown as {
      sessions: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    expect(page1.sessions).toHaveLength(2);
    expect(page1.nextCursor).toEqual(expect.any(String));
    for (const summary of page1.sessions) {
      expect(Object.keys(summary).sort()).toEqual(
        [
          'createdAt',
          'endingTitle',
          'scenarioId',
          'scenarioTitle',
          'scenarioVersion',
          'sceneTitle',
          'sessionId',
          'status',
          'updatedAt',
        ].sort(),
      );
    }
    for (const leaked of ['npcKnowledge', 'stateHash', 'payload', 'idempotency', 'requestHash']) {
      expect(first.text).not.toContain(leaked);
    }

    const second = await call('GET', `?limit=2&cursor=${page1.nextCursor}`, ownerId);
    const page2 = second.json as unknown as {
      sessions: Array<{ sessionId: string }>;
      nextCursor: string | null;
    };
    expect(page2.nextCursor).toBeNull();
    const seen = [...page1.sessions, ...page2.sessions].map((s) => s.sessionId);
    expect(seen.sort()).toEqual([...ids].sort());
  });
});
