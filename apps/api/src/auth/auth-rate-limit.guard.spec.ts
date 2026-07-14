import { describe, it, expect, vi } from 'vitest';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { Env } from '../config/env.schema';
import { RateLimiterService } from '../rate-limit/rate-limiter.service';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';

function createConfig(
  windowMs: number,
  maxAttempts: number,
  ipMaxAttempts = maxAttempts,
): ConfigService<Env, true> {
  const values: Record<string, number> = {
    AUTH_RATE_LIMIT_WINDOW_MS: windowMs,
    AUTH_RATE_LIMIT_MAX_ATTEMPTS: maxAttempts,
    AUTH_RATE_LIMIT_IP_MAX_ATTEMPTS: ipMaxAttempts,
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
  it('allows requests below the configured max attempts', async () => {
    const rateLimiter = new RateLimiterService();
    const guard = new AuthRateLimitGuard(rateLimiter, createConfig(60_000, 3));
    const { context } = createContext({});

    expect(await guard.canActivate(context)).toBe(true);
    expect(await guard.canActivate(context)).toBe(true);
    expect(await guard.canActivate(context)).toBe(true);
  });

  it('throws a 429 with the RATE_LIMITED code once the limit is exceeded', async () => {
    const rateLimiter = new RateLimiterService();
    const guard = new AuthRateLimitGuard(rateLimiter, createConfig(60_000, 2));
    const { context, response } = createContext({});

    await guard.canActivate(context);
    await guard.canActivate(context);

    let thrown: unknown;
    try {
      await guard.canActivate(context);
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

  it('does not block a different route/handler after one is rate limited', async () => {
    const rateLimiter = new RateLimiterService();
    const guard = new AuthRateLimitGuard(rateLimiter, createConfig(60_000, 1));

    const { context: loginContext } = createContext({ handlerName: 'login' });
    const { context: registerContext } = createContext({ handlerName: 'register' });

    await guard.canActivate(loginContext);
    await expect(guard.canActivate(loginContext)).rejects.toThrow(HttpException);

    expect(await guard.canActivate(registerContext)).toBe(true);
  });

  it('scopes the per-email budget so one email does not exhaust another user sharing the IP', async () => {
    const rateLimiter = new RateLimiterService();
    // Per-email budget of 1, but a generous IP budget (100) so this test
    // isolates the per-email bucket specifically, rather than the shared IP
    // bucket incidentally blocking bob's very first request too.
    const guard = new AuthRateLimitGuard(rateLimiter, createConfig(60_000, 1, 100));

    const { context: aliceContext } = createContext({ body: { email: 'alice@example.com' } });
    const { context: bobContext } = createContext({ body: { email: 'bob@example.com' } });

    await guard.canActivate(aliceContext);
    await expect(guard.canActivate(aliceContext)).rejects.toThrow(HttpException);

    expect(await guard.canActivate(bobContext)).toBe(true);
  });

  it('scopes the limit per IP when no email is present on the body', async () => {
    const rateLimiter = new RateLimiterService();
    const guard = new AuthRateLimitGuard(rateLimiter, createConfig(60_000, 1));

    const { context: ipAContext } = createContext({ ip: '10.0.0.1' });
    const { context: ipBContext } = createContext({ ip: '10.0.0.2' });

    await guard.canActivate(ipAContext);
    await expect(guard.canActivate(ipAContext)).rejects.toThrow(HttpException);

    expect(await guard.canActivate(ipBContext)).toBe(true);
  });

  describe('two-bucket enforcement (regression: previously only one key was ever consumed)', () => {
    it('still blocks on the IP-wide budget even when the attacker rotates emails on every request', async () => {
      const rateLimiter = new RateLimiterService();
      // IP budget allows 2 requests total; per-email budget allows 100 (so it
      // would never be the thing that blocks) — isolates the IP-wide bucket.
      const guard = new AuthRateLimitGuard(rateLimiter, createConfig(60_000, 2));

      const { context: first } = createContext({ ip: '1.2.3.4', body: { email: 'a@example.com' } });
      const { context: second } = createContext({ ip: '1.2.3.4', body: { email: 'b@example.com' } });
      const { context: third } = createContext({ ip: '1.2.3.4', body: { email: 'c@example.com' } });

      await guard.canActivate(first);
      await guard.canActivate(second);

      // A third request from the same IP with yet another new email must
      // still be blocked by the IP-wide budget, even though 'c@example.com'
      // itself has never been seen before.
      await expect(guard.canActivate(third)).rejects.toThrow(HttpException);
    });

    it('consumes both the IP bucket and the IP+email bucket on a single request', async () => {
      const rateLimiter = new RateLimiterService();
      const consumeSpy = vi.spyOn(rateLimiter, 'consume');
      const guard = new AuthRateLimitGuard(rateLimiter, createConfig(60_000, 5));
      const { context } = createContext({ ip: '9.9.9.9', body: { email: 'user@example.com' } });

      await guard.canActivate(context);

      expect(consumeSpy).toHaveBeenCalledTimes(2);
      const keys = consumeSpy.mock.calls.map((call) => call[0]);
      expect(keys[0]).toContain(':ip:9.9.9.9');
      expect(keys[1]).toContain(':ip-email:9.9.9.9:');
      // The email itself must never appear in the key — only its hash.
      expect(keys[1]).not.toContain('user@example.com');
    });
  });
});
