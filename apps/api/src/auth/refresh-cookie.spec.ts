import { describe, expect, it } from 'vitest';
import { buildRefreshCookieOptions } from './refresh-cookie';

describe('buildRefreshCookieOptions', () => {
  it('uses Lax by default in production instead of enabling cross-site cookies indiscriminately', () => {
    expect(buildRefreshCookieOptions('production')).toMatchObject({
      secure: true,
      sameSite: 'lax',
    });
  });

  it('forces Secure when an explicit cross-site deployment selects SameSite=None', () => {
    expect(buildRefreshCookieOptions('development', 'none')).toMatchObject({
      secure: true,
      sameSite: 'none',
    });
  });
});
