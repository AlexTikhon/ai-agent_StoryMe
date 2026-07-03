import { getAuthMode } from '../auth/mode';
import { getAccessToken, setAccessToken } from '../auth/token-store';
import { ApiError, parseApiError } from './api-error';
import { authApi } from './auth';

const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000/api';
const DEV_EMAIL = 'dev@storyme.local';
const DEV_NAME = 'Dev User';

export { ApiError };

/**
 * Fired when a silent refresh-on-401 fails (refresh cookie missing/expired/
 * revoked) — i.e. the session is truly over, not just the access token.
 * AuthProvider listens for this to flip status to 'anon', which the
 * dashboard layout's existing redirect effect turns into a /login bounce.
 * Only ever dispatched in jwt mode — dev mode never calls refreshOnce.
 */
export const AUTH_EXPIRED_EVENT = 'storyme:auth-expired';

function notifyAuthExpired(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }
}

// Coalesces concurrent 401s onto a single in-flight refresh instead of firing
// one POST /api/auth/refresh per failed request.
let refreshInFlight: Promise<string | null> | null = null;

function identityHeaders(): Record<string, string> {
  if (getAuthMode() === 'dev') {
    return { 'x-user-email': DEV_EMAIL, 'x-user-name': DEV_NAME };
  }
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function refreshOnce(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = authApi
      .refresh()
      .then((res) => {
        setAccessToken(res.accessToken);
        return res.accessToken;
      })
      .catch(() => {
        setAccessToken(null);
        notifyAuthExpired();
        return null;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

function rawFetch(
  path: string,
  init: RequestInit | undefined,
  baseHeaders: Record<string, string>,
) {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    // Required so the refresh cookie round-trips cross-origin (jwt mode); a
    // harmless no-op in dev mode, which carries identity via headers instead.
    credentials: 'include',
    headers: {
      ...baseHeaders,
      ...identityHeaders(),
      ...(init?.headers as Record<string, string>),
    },
  });
}

export async function apiFetch<T>(path: string, init?: RequestInit, isRetry = false): Promise<T> {
  const res = await rawFetch(path, init, { 'Content-Type': 'application/json' });

  if (res.status === 401 && !isRetry && getAuthMode() === 'jwt') {
    const newToken = await refreshOnce();
    if (newToken) {
      return apiFetch<T>(path, init, true);
    }
  }

  if (res.status === 204) return undefined as T;

  if (!res.ok) {
    const { message, code } = await parseApiError(res);
    throw new ApiError(res.status, message, code);
  }

  return res.json() as Promise<T>;
}

/** Like apiFetch, but for endpoints that return a binary body (e.g. PDF downloads). */
export async function apiFetchBlob(
  path: string,
  init?: RequestInit,
  isRetry = false,
): Promise<Blob> {
  const res = await rawFetch(path, init, {});

  if (res.status === 401 && !isRetry && getAuthMode() === 'jwt') {
    const newToken = await refreshOnce();
    if (newToken) {
      return apiFetchBlob(path, init, true);
    }
  }

  if (!res.ok) {
    const { message, code } = await parseApiError(res);
    throw new ApiError(res.status, message, code);
  }

  return res.blob();
}
