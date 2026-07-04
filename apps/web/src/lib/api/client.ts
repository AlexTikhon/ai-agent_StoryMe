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
// one POST /api/auth/refresh per failed request. This only covers one JS
// context — see the localStorage-based cross-tab coordination below for the
// multi-tab case.
let refreshInFlight: Promise<string | null> | null = null;

// Cross-tab coordination: when tab A is mid-refresh, tab B should wait for
// A's result instead of firing its own POST /api/auth/refresh — both tabs
// may be racing on the same (about-to-be-rotated) refresh cookie, and two
// simultaneous refresh calls are exactly the multi-tab logout scenario this
// guards against. The server tolerates a stray duplicate call via a short
// reuse grace period (see AuthService.REFRESH_REUSE_GRACE_MS), so this is a
// best-effort optimization, not a correctness requirement: if the lock or
// storage event is unavailable/missed, the tab just falls back to its own
// refresh call.
export const REFRESH_LOCK_KEY = 'storyme:refresh-lock';
export const REFRESH_RESULT_KEY = 'storyme:refresh-result';
const REFRESH_LOCK_TTL_MS = 8000;
const REFRESH_WAIT_TIMEOUT_MS = 5000;

interface RefreshLock {
  id: string;
  startedAt: number;
}

interface RefreshResult {
  lockId: string;
  token: string | null;
}

function readJSON<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private browsing, quota) — coordination is
    // best-effort, so just skip it.
  }
}

function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** Waits for the tab holding `lockId` to publish its refresh result, falling back to null (triggering our own refresh) if it never does. */
function waitForCrossTabRefresh(lockId: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (token: string | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('storage', onStorage);
      clearTimeout(timer);
      resolve(token);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== REFRESH_RESULT_KEY || !event.newValue) return;
      const result = readJSON<RefreshResult>(REFRESH_RESULT_KEY);
      if (result?.lockId === lockId) finish(result.token);
    };
    window.addEventListener('storage', onStorage);
    const timer = setTimeout(() => finish(null), REFRESH_WAIT_TIMEOUT_MS);
  });
}

function identityHeaders(): Record<string, string> {
  if (getAuthMode() === 'dev') {
    return { 'x-user-email': DEV_EMAIL, 'x-user-name': DEV_NAME };
  }
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Actually calls POST /api/auth/refresh, publishing the result for any tab waiting on `waitForCrossTabRefresh`. */
function performOwnRefresh(): Promise<string | null> {
  const lockId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (typeof window !== 'undefined') {
    writeJSON(REFRESH_LOCK_KEY, { id: lockId, startedAt: Date.now() } satisfies RefreshLock);
  }

  return authApi
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
    .then((token) => {
      if (typeof window !== 'undefined') {
        writeJSON(REFRESH_RESULT_KEY, { lockId, token } satisfies RefreshResult);
        removeKey(REFRESH_LOCK_KEY);
      }
      return token;
    });
}

function refreshOnce(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  if (typeof window !== 'undefined') {
    const existingLock = readJSON<RefreshLock>(REFRESH_LOCK_KEY);
    if (existingLock && Date.now() - existingLock.startedAt < REFRESH_LOCK_TTL_MS) {
      // Another tab is already refreshing — wait for its result instead of
      // racing it with a second POST /api/auth/refresh.
      refreshInFlight = waitForCrossTabRefresh(existingLock.id)
        .then((token) => {
          if (token) {
            // The token belongs to the other tab's in-memory store — this
            // tab needs its own copy for identityHeaders() to pick it up.
            setAccessToken(token);
            return token;
          }
          // The other tab never published a result in time (or its refresh
          // failed) — fall back to doing it ourselves rather than assuming
          // the session is dead.
          return performOwnRefresh();
        })
        .finally(() => {
          refreshInFlight = null;
        });
      return refreshInFlight;
    }
  }

  refreshInFlight = performOwnRefresh().finally(() => {
    refreshInFlight = null;
  });
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
