import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AuthModeGuard } from '../auth/auth-mode.guard';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import { InteractiveController } from './interactive.controller';
import type { InteractiveService } from './interactive.service';

const USER = { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' } as User;
const SESSION_ID = '9b2e7a9e-0f1c-4d5b-8a53-2f0f6a2e7c11';

function setup() {
  const service = {
    createSession: vi.fn().mockResolvedValue({ ok: 'create' }),
    getSession: vi.fn().mockResolvedValue({ ok: 'get' }),
    submitChoice: vi.fn().mockResolvedValue({ ok: 'choose' }),
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
    await controller.create(USER, { scenarioId: 'warsaw-last-delivery' });
    expect(service.createSession).toHaveBeenCalledWith(USER.id, 'warsaw-last-delivery');

    await controller.findOne(USER, SESSION_ID);
    expect(service.getSession).toHaveBeenCalledWith(USER.id, SESSION_ID);

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
      controller.create(USER, { scenarioId: 'warsaw-last-delivery', userId: 'someone-else' }),
    ).toThrow(BadRequestException);
    expect(() => controller.findOne(USER, 'not-a-uuid')).toThrow(BadRequestException);
    expect(() =>
      controller.choose(USER, SESSION_ID, {
        choiceId: 'c-ask-caretaker',
        expectedRevision: 0,
        idempotencyKey: 'key-00001',
        userId: 'someone-else',
      }),
    ).toThrow(BadRequestException);
    expect(service.createSession).not.toHaveBeenCalled();
    expect(service.getSession).not.toHaveBeenCalled();
    expect(service.submitChoice).not.toHaveBeenCalled();
  });
});
