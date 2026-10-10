import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuthModeGuard } from '../auth/auth-mode.guard';
import { RATE_LIMIT_KEY } from '../rate-limit/rate-limit.decorator';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import { InteractiveScenariosController } from './interactive-scenarios.controller';
import type { InteractiveService } from './interactive.service';

function setup() {
  const catalogue = { scenarios: [] };
  const service = { listScenarios: vi.fn().mockReturnValue(catalogue) };
  return {
    catalogue,
    service,
    controller: new InteractiveScenariosController(service as unknown as InteractiveService),
  };
}

describe('InteractiveScenariosController', () => {
  it('is served at /interactive/scenarios behind authentication and per-user rate limits', () => {
    expect(Reflect.getMetadata('__guards__', InteractiveScenariosController)).toEqual([
      AuthModeGuard,
      UserRateLimitGuard,
    ]);
    expect(Reflect.getMetadata('path', InteractiveScenariosController)).toBe(
      'interactive/scenarios',
    );
    expect(Reflect.getMetadata('path', InteractiveScenariosController.prototype.list)).toBe('/');
    expect(Reflect.getMetadata('method', InteractiveScenariosController.prototype.list)).toBe(0); // GET
  });

  it('uses the shared interactive read budget', () => {
    expect(
      Reflect.getMetadata(RATE_LIMIT_KEY, InteractiveScenariosController.prototype.list),
    ).toEqual({
      windowMsEnvKey: 'INTERACTIVE_READ_RATE_LIMIT_WINDOW_MS',
      maxAttemptsEnvKey: 'INTERACTIVE_READ_RATE_LIMIT_MAX_ATTEMPTS',
    });
  });

  it('returns the service catalogue and accepts no query parameters', () => {
    const { controller, service, catalogue } = setup();
    expect(controller.list({})).toBe(catalogue);
    expect(service.listScenarios).toHaveBeenCalledTimes(1);
    expect(() => controller.list({ limit: '5' })).toThrow(BadRequestException);
    expect(() => controller.list({ scenarioId: 'warsaw-last-tram' })).toThrow(BadRequestException);
    expect(service.listScenarios).toHaveBeenCalledTimes(1);
  });

  it('marks the response private and uncacheable', () => {
    expect(
      Reflect.getMetadata('__headers__', InteractiveScenariosController.prototype.list),
    ).toEqual([{ name: 'Cache-Control', value: 'private, no-store' }]);
  });
});
