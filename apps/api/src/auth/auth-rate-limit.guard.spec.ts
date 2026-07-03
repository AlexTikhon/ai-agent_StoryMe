import { describe, it, expect, vi } from 'vitest';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { Env } from '../config/env.schema';
import { RateLimiterService } from '../rate-limit/rate-limiter.service';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';

function createConfig(windowMs: number, maxAttempts: number): ConfigService<Env, true> {
  const values: Record<string, number> = {
    AUTH_RATE_LIMIT_WINDOW_MS: windowMs,
    AUTH_RATE_LIMIT_MAX_ATTEMPTS: maxAttempts,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<Env, true>;
}

function createContext(options: {
  ip?: string;
  body?: unknown;
  handlerName?: string;
  className?: string;
}): { context: ExecutionContext; response: Response } {
  const request = { ip: options.ip ?? '127.0.0.1', body: options.body } as unknown as Request;
  const response = { setHeader: vi.fn() } as unknown as Response;
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
    getClass: () => ({ name: options.className ?? 'AuthController' }),
    getHandler: () => ({ name: options.handlerName ?? 'login' }),
  } as unknown as ExecutionContext;
  return { context, response };
}

describe('AuthRateLimitGuard', () => {
  it('allows requests below the configured max attempts', () => {
    const rateLimiter = new RateLimiterService();
    const guard = new AuthRateLimitGuard(rateLimiter, createConfig(60_000, 3));
    const { context } = createContext({});

    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('throws a 429 with the RATE_LIMITED code once the limit is exceeded', () => {
    const rateLimiter = new RateLimiterService();
    const guard = new AuthRateLimitGuard(rateLimiter, createConfig(60_000, 2));
    const { context, response } = createContext({});

    guard.canActivate(context);
    guard.canActivate(context);

    let thrown: unknown;
    try {
      guard.canActivate(context);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    const exception = thrown as HttpException;
    expect(exception.getStatus()).toBe(429);
    expect(exception.getResponse()).toEqual({
      error: 'Too many requests',
      code: 'RATE_LIMITED',
    });
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  it('does not block a different route/handler after one is rate limited', () => {
    const rateLimiter = new RateLimiterService();
    const guard = new AuthRateLimitGuard(rateLimiter, createConfig(60_000, 1));

    const { context: loginContext } = createContext({ handlerName: 'login' });
    const { context: registerContext } = createContext({ handlerName: 'register' });

    guard.canActivate(loginContext);
    expect(() => guard.canActivate(loginContext)).toThrow(HttpException);

    expect(guard.canActivate(registerContext)).toBe(true);
  });

  it('scopes the limit per email so one email does not exhaust another user sharing the IP', () => {
    const rateLimiter = new RateLimiterService();
    const guard = new AuthRateLimitGuard(rateLimiter, createConfig(60_000, 1));

    const { context: aliceContext } = createContext({ body: { email: 'alice@example.com' } });
    const { context: bobContext } = createContext({ body: { email: 'bob@example.com' } });

    guard.canActivate(aliceContext);
    expect(() => guard.canActivate(aliceContext)).toThrow(HttpException);

    expect(guard.canActivate(bobContext)).toBe(true);
  });

  it('scopes the limit per IP when no email is present on the body', () => {
    const rateLimiter = new RateLimiterService();
    const guard = new AuthRateLimitGuard(rateLimiter, createConfig(60_000, 1));

    const { context: ipAContext } = createContext({ ip: '10.0.0.1' });
    const { context: ipBContext } = createContext({ ip: '10.0.0.2' });

    guard.canActivate(ipAContext);
    expect(() => guard.canActivate(ipAContext)).toThrow(HttpException);

    expect(guard.canActivate(ipBContext)).toBe(true);
  });
});
