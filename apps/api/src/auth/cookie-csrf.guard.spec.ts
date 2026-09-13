import { describe, expect, it } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { CookieCsrfGuard } from './cookie-csrf.guard';

function context(headers: Record<string, string | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        get: (name: string) => headers[name.toLowerCase()],
      }),
    }),
  } as unknown as ExecutionContext;
}

function guard(): CookieCsrfGuard {
  const config = {
    get: () => 'https://app.storyme.test,https://preview.storyme.test',
  } as unknown as ConfigService<Env, true>;
  return new CookieCsrfGuard(config);
}

describe('CookieCsrfGuard', () => {
  it('allows an exact configured browser origin', () => {
    expect(guard().canActivate(context({ origin: 'https://app.storyme.test' }))).toBe(true);
  });

  it('rejects a cross-site simple POST before the controller can read a response body', () => {
    expect(() =>
      guard().canActivate(
        context({ origin: 'https://attacker.test', 'sec-fetch-site': 'cross-site' }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects missing Origin and Fetch Metadata by default', () => {
    expect(() => guard().canActivate(context({}))).toThrow(ForbiddenException);
  });

  it('allows same-origin Fetch Metadata and deliberate non-browser callers', () => {
    expect(guard().canActivate(context({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(guard().canActivate(context({ 'x-storyme-csrf': '1' }))).toBe(true);
  });
});
