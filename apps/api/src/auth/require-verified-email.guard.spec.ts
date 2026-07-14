import { describe, it, expect } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import type { Env } from '../config/env.schema';
import type { RequestWithUser } from './request-with-user';
import { RequireVerifiedEmailGuard } from './require-verified-email.guard';

function createConfig(authMode: 'dev' | 'jwt'): ConfigService<Env, true> {
  return { get: () => authMode } as unknown as ConfigService<Env, true>;
}

function createContext(user: Partial<User> | undefined): ExecutionContext {
  const request = { user } as RequestWithUser;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('RequireVerifiedEmailGuard', () => {
  it('allows a verified user through in jwt mode', () => {
    const guard = new RequireVerifiedEmailGuard(createConfig('jwt'));
    expect(guard.canActivate(createContext({ emailVerified: true }))).toBe(true);
  });

  it('throws 403 EMAIL_NOT_VERIFIED for an unverified user in jwt mode', () => {
    const guard = new RequireVerifiedEmailGuard(createConfig('jwt'));
    let thrown: unknown;
    try {
      guard.canActivate(createContext({ emailVerified: false }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect((thrown as ForbiddenException).getStatus()).toBe(403);
    expect((thrown as ForbiddenException).getResponse()).toEqual({
      error: 'Email is not verified',
      message: 'Email is not verified',
      code: 'EMAIL_NOT_VERIFIED',
    });
  });

  it('is skipped entirely in dev mode, even for an unverified (or missing) user', () => {
    const guard = new RequireVerifiedEmailGuard(createConfig('dev'));
    expect(guard.canActivate(createContext({ emailVerified: false }))).toBe(true);
    expect(guard.canActivate(createContext(undefined))).toBe(true);
  });
});
