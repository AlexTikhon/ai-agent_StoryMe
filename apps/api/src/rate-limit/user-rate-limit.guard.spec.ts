import { describe, it, expect, vi } from 'vitest';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { User } from '@prisma/client';
import type { Env } from '../config/env.schema';
import type { RequestWithUser } from '../auth/request-with-user';
import { RateLimiterService } from './rate-limiter.service';
import { UserRateLimitGuard } from './user-rate-limit.guard';
import { RATE_LIMIT_KEY, type RateLimitOptions } from './rate-limit.decorator';

function createConfig(windowMs: number, maxAttempts: number): ConfigService<Env, true> {
  const values: Record<string, number> = {
    GENERATION_RATE_LIMIT_WINDOW_MS: windowMs,
    GENERATION_RATE_LIMIT_MAX_ATTEMPTS: maxAttempts,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<Env, true>;
}

function createReflector(options: RateLimitOptions | undefined): Reflector {
  return {
    get: (key: string) => (key === RATE_LIMIT_KEY ? options : undefined),
  } as unknown as Reflector;
}

function createContext(userId: string | undefined, handlerName = 'generate'): ExecutionContext {
  const request = { user: userId ? ({ id: userId } as User) : undefined } as RequestWithUser;
  const response = { setHeader: vi.fn() } as unknown as Response;
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
    getClass: () => ({ name: 'BooksController' }),
    getHandler: () => ({ name: handlerName }),
  } as unknown as ExecutionContext;
}

const OPTIONS: RateLimitOptions = {
  windowMsEnvKey: 'GENERATION_RATE_LIMIT_WINDOW_MS',
  maxAttemptsEnvKey: 'GENERATION_RATE_LIMIT_MAX_ATTEMPTS',
};

describe('UserRateLimitGuard', () => {
  it('allows a handler through untouched when it has no @RateLimit() metadata', async () => {
    const guard = new UserRateLimitGuard(
      new RateLimiterService(),
      createConfig(60_000, 1),
      createReflector(undefined),
    );

    const context = createContext('user-1');
    expect(await guard.canActivate(context)).toBe(true);
    expect(await guard.canActivate(context)).toBe(true);
  });

  it('rate limits per user id, not per IP', async () => {
    const guard = new UserRateLimitGuard(
      new RateLimiterService(),
      createConfig(60_000, 1),
      createReflector(OPTIONS),
    );

    const userA = createContext('user-a');
    const userB = createContext('user-b');

    expect(await guard.canActivate(userA)).toBe(true);
    await expect(guard.canActivate(userA)).rejects.toThrow(HttpException);
    // A different user must have an independent budget.
    expect(await guard.canActivate(userB)).toBe(true);
  });

  it('lets an unauthenticated request through (an upstream auth guard is responsible for rejecting it)', async () => {
    const guard = new UserRateLimitGuard(
      new RateLimiterService(),
      createConfig(60_000, 1),
      createReflector(OPTIONS),
    );

    expect(await guard.canActivate(createContext(undefined))).toBe(true);
  });

  it('throws 429 with RATE_LIMITED code and sets Retry-After once exceeded', async () => {
    const guard = new UserRateLimitGuard(
      new RateLimiterService(),
      createConfig(60_000, 1),
      createReflector(OPTIONS),
    );
    const context = createContext('user-1');
    const response = context.switchToHttp().getResponse<Response>();

    await guard.canActivate(context);

    let thrown: unknown;
    try {
      await guard.canActivate(context);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(429);
    expect((thrown as HttpException).getResponse()).toEqual({
      error: 'Too many requests',
      code: 'RATE_LIMITED',
    });
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });
});
