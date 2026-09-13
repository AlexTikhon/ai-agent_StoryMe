import type { CookieOptions } from 'express';

export const REFRESH_COOKIE_NAME = 'storyme_refresh';
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * SameSite=None requires Secure, which requires HTTPS — not available for
 * local http dev. Falls back to Lax/non-secure outside production, mirroring
 * DevAuthGuard's own NODE_ENV-gated split.
 */
export type RefreshCookieSameSite = 'lax' | 'strict' | 'none';

export function buildRefreshCookieOptions(
  nodeEnv: string,
  sameSite: RefreshCookieSameSite = 'lax',
): CookieOptions {
  const isProd = nodeEnv === 'production';
  return {
    httpOnly: true,
    secure: isProd || sameSite === 'none',
    sameSite,
    path: '/api/auth',
    maxAge: REFRESH_TOKEN_TTL_MS,
  };
}
