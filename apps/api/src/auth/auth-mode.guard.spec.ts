import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { AuthModeGuard } from './auth-mode.guard';
import type { DevAuthGuard } from './dev-auth.guard';
import type { JwtAuthGuard } from './jwt-auth.guard';

function createConfig(authMode: Env['AUTH_MODE']): ConfigService<Env, true> {
  return { get: () => authMode } as unknown as ConfigService<Env, true>;
}

const FAKE_CONTEXT = {} as ExecutionContext;

describe('AuthModeGuard', () => {
  it('delegates to DevAuthGuard when AUTH_MODE=dev', async () => {
    const devAuthGuard = {
      canActivate: vi.fn().mockResolvedValue(true),
    } as unknown as DevAuthGuard;
    const jwtAuthGuard = { canActivate: vi.fn() } as unknown as JwtAuthGuard;
    const guard = new AuthModeGuard(createConfig('dev'), devAuthGuard, jwtAuthGuard);

    const result = await guard.canActivate(FAKE_CONTEXT);

    expect(result).toBe(true);
    expect(devAuthGuard.canActivate).toHaveBeenCalledWith(FAKE_CONTEXT);
    expect(jwtAuthGuard.canActivate).not.toHaveBeenCalled();
  });

  it('delegates to JwtAuthGuard when AUTH_MODE=jwt', async () => {
    const devAuthGuard = { canActivate: vi.fn() } as unknown as DevAuthGuard;
    const jwtAuthGuard = {
      canActivate: vi.fn().mockResolvedValue(true),
    } as unknown as JwtAuthGuard;
    const guard = new AuthModeGuard(createConfig('jwt'), devAuthGuard, jwtAuthGuard);

    const result = await guard.canActivate(FAKE_CONTEXT);

    expect(result).toBe(true);
    expect(jwtAuthGuard.canActivate).toHaveBeenCalledWith(FAKE_CONTEXT);
    expect(devAuthGuard.canActivate).not.toHaveBeenCalled();
  });

  it('propagates a JwtAuthGuard rejection (e.g. missing/invalid token) in jwt mode', async () => {
    const devAuthGuard = { canActivate: vi.fn() } as unknown as DevAuthGuard;
    const jwtAuthGuard = {
      canActivate: vi.fn().mockRejectedValue(new Error('Missing bearer token')),
    } as unknown as JwtAuthGuard;
    const guard = new AuthModeGuard(createConfig('jwt'), devAuthGuard, jwtAuthGuard);

    await expect(guard.canActivate(FAKE_CONTEXT)).rejects.toThrow('Missing bearer token');
  });
});
