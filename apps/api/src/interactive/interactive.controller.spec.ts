import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AuthModeGuard } from '../auth/auth-mode.guard';
import { RATE_LIMIT_KEY } from '../rate-limit/rate-limit.decorator';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import { InteractiveController } from './interactive.controller';
import type { InteractiveService } from './interactive.service';

const USER = { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' } as User;
const SESSION_ID = '9b2e7a9e-0f1c-4d5b-8a53-2f0f6a2e7c11';

function setup() {
  const service = {
    createSession: vi.fn().mockResolvedValue({ ok: 'create' }),
    listSessions: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
    getSession: vi.fn().mockResolvedValue({ ok: 'get' }),
    submitChoice: vi.fn().mockResolvedValue({ ok: 'choose' }),
    getPresentation: vi.fn().mockResolvedValue({ ok: 'presentation' }),
  };
  return {
    service,
    controller: new InteractiveController(service as unknown as InteractiveService),
  };
}

describe('InteractiveController', () => {
  it('is protected by the standard authentication and per-user rate-limit guards', () => {
    expect(Reflect.getMetadata('__guards__', InteractiveController)).toEqual([
      AuthModeGuard,
      UserRateLimitGuard,
    ]);
    expect(Reflect.getMetadata('path', InteractiveController)).toBe('interactive/sessions');
  });

  it('takes the owner only from the authenticated user', async () => {
    const { controller, service } = setup();
    const creation = { scenarioId: 'warsaw-last-delivery', idempotencyKey: 'start-00001' };
    await controller.create(USER, creation);
    expect(service.createSession).toHaveBeenCalledWith(USER.id, creation);

    await controller.list(USER, { limit: '5' });
    expect(service.listSessions).toHaveBeenCalledWith(USER.id, { limit: 5, cursor: null });

    await controller.findOne(USER, SESSION_ID);
    expect(service.getSession).toHaveBeenCalledWith(USER.id, SESSION_ID);

    await controller.presentation(USER, SESSION_ID, { expectedRevision: '3' });
    expect(service.getPresentation).toHaveBeenCalledWith(USER.id, SESSION_ID, 3);

    const command = {
      choiceId: 'c-ask-caretaker',
      expectedRevision: 0,
      idempotencyKey: 'key-00001',
    };
    await controller.choose(USER, SESSION_ID, command);
    expect(service.submitChoice).toHaveBeenCalledWith(USER.id, SESSION_ID, command);
  });

  it('rejects an owner id supplied in the body and never reaches the service', () => {
    const { controller, service } = setup();
    expect(() =>
      controller.create(USER, {
        scenarioId: 'warsaw-last-delivery',
        idempotencyKey: 'start-00001',
        userId: 'someone-else',
      }),
    ).toThrow(BadRequestException);
    expect(() => controller.create(USER, { scenarioId: 'warsaw-last-delivery' })).toThrow(
      BadRequestException,
    );
    expect(() => controller.list(USER, { userId: 'someone-else' })).toThrow(BadRequestException);
    expect(() => controller.list(USER, { limit: '500' })).toThrow(BadRequestException);
    expect(() => controller.findOne(USER, 'not-a-uuid')).toThrow(BadRequestException);
    expect(() => controller.presentation(USER, 'not-a-uuid', { expectedRevision: '0' })).toThrow(
      BadRequestException,
    );
    expect(() => controller.presentation(USER, SESSION_ID, {})).toThrow(BadRequestException);
    expect(() => controller.presentation(USER, SESSION_ID, { expectedRevision: '-1' })).toThrow(
      BadRequestException,
    );
    expect(() =>
      controller.presentation(USER, SESSION_ID, { expectedRevision: '0', userId: 'someone-else' }),
    ).toThrow(BadRequestException);
    expect(() =>
      controller.choose(USER, SESSION_ID, {
        choiceId: 'c-ask-caretaker',
        expectedRevision: 0,
        idempotencyKey: 'key-00001',
        userId: 'someone-else',
      }),
    ).toThrow(BadRequestException);
    expect(service.createSession).not.toHaveBeenCalled();
    expect(service.listSessions).not.toHaveBeenCalled();
    expect(service.getSession).not.toHaveBeenCalled();
    expect(service.submitChoice).not.toHaveBeenCalled();
    expect(service.getPresentation).not.toHaveBeenCalled();
  });

  it('applies the configured request budgets to every endpoint', () => {
    const budget = (handler: keyof InteractiveController) =>
      Reflect.getMetadata(RATE_LIMIT_KEY, InteractiveController.prototype[handler]);
    expect(budget('create')).toEqual({
      windowMsEnvKey: 'INTERACTIVE_CREATE_RATE_LIMIT_WINDOW_MS',
      maxAttemptsEnvKey: 'INTERACTIVE_CREATE_RATE_LIMIT_MAX_ATTEMPTS',
    });
    expect(budget('choose')).toEqual({
      windowMsEnvKey: 'INTERACTIVE_CHOICE_RATE_LIMIT_WINDOW_MS',
      maxAttemptsEnvKey: 'INTERACTIVE_CHOICE_RATE_LIMIT_MAX_ATTEMPTS',
    });
    const read = {
      windowMsEnvKey: 'INTERACTIVE_READ_RATE_LIMIT_WINDOW_MS',
      maxAttemptsEnvKey: 'INTERACTIVE_READ_RATE_LIMIT_MAX_ATTEMPTS',
    };
    expect(budget('findOne')).toEqual(read);
    expect(budget('list')).toEqual(read);
    expect(budget('presentation')).toEqual(read);
  });

  it('marks presentation metadata as private and uncacheable', () => {
    expect(
      Reflect.getMetadata('__httpCode__', InteractiveController.prototype.presentation),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata('__headers__', InteractiveController.prototype.presentation),
    ).toEqual([{ name: 'Cache-Control', value: 'private, no-store' }]);
    expect(Reflect.getMetadata('path', InteractiveController.prototype.presentation)).toBe(
      ':id/presentation',
    );
  });
});
