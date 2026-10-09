import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AuthModeGuard } from '../../src/auth/auth-mode.guard';
import type { RequestWithUser } from '../../src/auth/request-with-user';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { PrismaService } from '../../src/database/prisma.service';
import { InteractiveController } from '../../src/interactive/interactive.controller';
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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InteractiveController],
      providers: [
        PrismaService,
        InteractiveService,
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
  ): Promise<{ status: number; json: ApiBody; text: string }> {
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
    return { status: response.status, json: (text ? JSON.parse(text) : null) as ApiBody, text };
  }

  const stable = (json: Record<string, unknown>) => {
    const { timestamp: _t, requestId: _r, path: _p, ...rest } = json;
    return rest;
  };

  it('walks create -> read -> choose -> resume over HTTP', async () => {
    const userId = await newUser();
    const created = await call('POST', '', userId, { scenarioId: 'warsaw-last-delivery' });
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
    const created = await call('POST', '', userId, { scenarioId: 'warsaw-last-delivery' });
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
    const created = await call('POST', '', ownerId, { scenarioId: 'warsaw-last-delivery' });
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

  it('answers malformed input with the stable INVALID_REQUEST code', async () => {
    const userId = await newUser();
    const created = await call('POST', '', userId, { scenarioId: 'warsaw-last-delivery' });
    const id = created.json.sessionId as string;
    const valid = {
      choiceId: 'c-ask-caretaker',
      expectedRevision: 0,
      idempotencyKey: 'http-key-0003',
    };

    const bad: Array<[string, string, unknown]> = [
      ['POST', '', {}],
      ['POST', '', { scenarioId: 'warsaw-last-delivery', userId: randomUUID() }],
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
    expect((await call('POST', '', userId, { scenarioId: 'nope' })).json.code).toBe(
      'UNKNOWN_SCENARIO',
    );
    // Nothing was written by any rejected request.
    expect(await prisma.sessionEvent.count({ where: { sessionId: id } })).toBe(1);
  });

  it('answers rule violations with stable codes', async () => {
    const userId = await newUser();
    const created = await call('POST', '', userId, { scenarioId: 'warsaw-last-delivery' });
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
});
