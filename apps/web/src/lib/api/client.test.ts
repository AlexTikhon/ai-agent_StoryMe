import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  apiFetch,
  apiFetchBlob,
  AUTH_EXPIRED_EVENT,
  REFRESH_LOCK_KEY,
  REFRESH_RESULT_KEY,
} from './client';
import { setAccessToken } from '../auth/token-store';

/** Simulates another browser tab publishing to localStorage — real browsers never fire `storage` in the writer's own window, only in other same-origin tabs. */
function publishFromAnotherTab(key: string, value: unknown): void {
  const newValue = JSON.stringify(value);
  window.localStorage.setItem(key, newValue);
  window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
}

function mockOk(body: unknown, status = 200): Response {
  return { ok: true, status, json: async () => body } as unknown as Response;
}

function mockUnauthorized(): Response {
  return {
    ok: false,
    status: 401,
    json: async () => ({ message: 'Unauthorized' }),
  } as unknown as Response;
}

describe('apiFetch / apiFetchBlob auth behavior', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    setAccessToken(null);
    window.localStorage.clear();
    delete process.env['NEXT_PUBLIC_AUTH_MODE'];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessToken(null);
    window.localStorage.clear();
    delete process.env['NEXT_PUBLIC_AUTH_MODE'];
  });

  describe('jwt mode (default)', () => {
    it('attaches Authorization: Bearer <token> when a token is set', async () => {
      setAccessToken('access-token-123');
      vi.mocked(fetch).mockResolvedValueOnce(mockOk({ ok: true }));

      await apiFetch('/books');

      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer access-token-123');
      expect(headers['x-user-email']).toBeUndefined();
      expect(init.credentials).toBe('include');
    });

    it('does not send x-user-email in jwt mode even with no token set', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockOk({ ok: true }));

      await apiFetch('/books');

      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['x-user-email']).toBeUndefined();
      expect(headers['Authorization']).toBeUndefined();
    });

    it('retries exactly once after a silent refresh on 401, then succeeds', async () => {
      setAccessToken('expired-token');
      vi.mocked(fetch)
        .mockResolvedValueOnce(mockUnauthorized()) // original request
        .mockResolvedValueOnce(
          mockOk({ accessToken: 'new-token', user: { id: 'u1', email: 'a@b.com' } }),
        ) // POST /auth/refresh
        .mockResolvedValueOnce(mockOk({ items: [] })); // retried request

      const result = await apiFetch('/books');

      expect(fetch).toHaveBeenCalledTimes(3);
      const refreshCall = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
      expect(refreshCall[0]).toBe('http://localhost:4000/api/auth/refresh');
      const retryCall = vi.mocked(fetch).mock.calls[2] as [string, RequestInit];
      const retryHeaders = retryCall[1].headers as Record<string, string>;
      expect(retryHeaders['Authorization']).toBe('Bearer new-token');
      expect(result).toEqual({ items: [] });
    });

    it('does not loop forever when refresh also fails — throws the original 401', async () => {
      setAccessToken('expired-token');
      vi.mocked(fetch)
        .mockResolvedValueOnce(mockUnauthorized()) // original request
        .mockResolvedValueOnce(mockUnauthorized()); // POST /auth/refresh also fails

      await expect(apiFetch('/books')).rejects.toThrow();
      // Exactly 2 calls: the original request + one refresh attempt. No further retries.
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('dispatches storyme:auth-expired when the silent refresh fails', async () => {
      setAccessToken('expired-token');
      const onExpired = vi.fn();
      window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
      vi.mocked(fetch)
        .mockResolvedValueOnce(mockUnauthorized())
        .mockResolvedValueOnce(mockUnauthorized());

      await expect(apiFetch('/books')).rejects.toThrow();

      expect(onExpired).toHaveBeenCalledTimes(1);
      window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
    });

    it('does not dispatch storyme:auth-expired when the silent refresh succeeds', async () => {
      setAccessToken('expired-token');
      const onExpired = vi.fn();
      window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
      vi.mocked(fetch)
        .mockResolvedValueOnce(mockUnauthorized())
        .mockResolvedValueOnce(mockOk({ accessToken: 'new-token', user: { id: 'u1' } }))
        .mockResolvedValueOnce(mockOk({ items: [] }));

      await apiFetch('/books');

      expect(onExpired).not.toHaveBeenCalled();
      window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
    });

    describe('cross-tab refresh coordination', () => {
      it("waits for another tab's in-flight refresh instead of firing its own POST /api/auth/refresh", async () => {
        setAccessToken('expired-token');
        publishFromAnotherTab(REFRESH_LOCK_KEY, { id: 'tab-a-lock', startedAt: Date.now() });

        vi.mocked(fetch)
          .mockResolvedValueOnce(mockUnauthorized()) // original request (this tab)
          .mockResolvedValueOnce(mockOk({ items: [] })); // retried request, once we get a token

        const resultPromise = apiFetch('/books');

        // Give the microtask queue a turn so refreshOnce() has registered its
        // storage listener before tab A's result arrives.
        await Promise.resolve();
        publishFromAnotherTab(REFRESH_RESULT_KEY, { lockId: 'tab-a-lock', token: 'shared-token' });

        const result = await resultPromise;

        // Only 2 fetch calls: the original 401 and the retry — no POST
        // /auth/refresh from this tab.
        expect(fetch).toHaveBeenCalledTimes(2);
        const retryCall = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
        const retryHeaders = retryCall[1].headers as Record<string, string>;
        expect(retryHeaders['Authorization']).toBe('Bearer shared-token');
        expect(result).toEqual({ items: [] });
      });

      it('ignores a stale lock (older than the TTL) and performs its own refresh', async () => {
        setAccessToken('expired-token');
        publishFromAnotherTab(REFRESH_LOCK_KEY, {
          id: 'stale-lock',
          startedAt: Date.now() - 60_000,
        });

        vi.mocked(fetch)
          .mockResolvedValueOnce(mockUnauthorized())
          .mockResolvedValueOnce(mockOk({ accessToken: 'own-token', user: { id: 'u1' } }))
          .mockResolvedValueOnce(mockOk({ items: [] }));

        const result = await apiFetch('/books');

        expect(fetch).toHaveBeenCalledTimes(3);
        const refreshCall = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
        expect(refreshCall[0]).toBe('http://localhost:4000/api/auth/refresh');
        expect(result).toEqual({ items: [] });
      });

      it('falls back to its own refresh if the cross-tab wait times out without a result', async () => {
        vi.useFakeTimers();
        try {
          setAccessToken('expired-token');
          publishFromAnotherTab(REFRESH_LOCK_KEY, { id: 'tab-a-lock', startedAt: Date.now() });

          vi.mocked(fetch)
            .mockResolvedValueOnce(mockUnauthorized())
            .mockResolvedValueOnce(mockOk({ accessToken: 'own-token', user: { id: 'u1' } }))
            .mockResolvedValueOnce(mockOk({ items: [] }));

          const resultPromise = apiFetch('/books');
          // Tab A never publishes a result (crashed, closed) — wait past the
          // cross-tab timeout so this tab falls back to its own refresh.
          await vi.advanceTimersByTimeAsync(6000);

          const result = await resultPromise;

          expect(fetch).toHaveBeenCalledTimes(3);
          const refreshCall = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
          expect(refreshCall[0]).toBe('http://localhost:4000/api/auth/refresh');
          expect(result).toEqual({ items: [] });
        } finally {
          vi.useRealTimers();
        }
      });

      it('publishes its refresh result to localStorage for other tabs and clears the lock', async () => {
        setAccessToken('expired-token');
        vi.mocked(fetch)
          .mockResolvedValueOnce(mockUnauthorized())
          .mockResolvedValueOnce(mockOk({ accessToken: 'new-token', user: { id: 'u1' } }))
          .mockResolvedValueOnce(mockOk({ items: [] }));

        await apiFetch('/books');

        expect(window.localStorage.getItem(REFRESH_LOCK_KEY)).toBeNull();
        const result = JSON.parse(window.localStorage.getItem(REFRESH_RESULT_KEY) ?? 'null') as {
          token: string | null;
        } | null;
        expect(result?.token).toBe('new-token');
      });
    });
  });

  describe('dev mode', () => {
    beforeEach(() => {
      process.env['NEXT_PUBLIC_AUTH_MODE'] = 'dev';
    });

    it('sends x-user-email/x-user-name and no Authorization header', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockOk({ ok: true }));

      await apiFetch('/books');

      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['x-user-email']).toBe('dev@storyme.local');
      expect(headers['x-user-name']).toBe('Dev User');
      expect(headers['Authorization']).toBeUndefined();
    });

    it('does not attempt a refresh retry on 401', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockUnauthorized());

      await expect(apiFetch('/books')).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('apiFetchBlob', () => {
    it('attaches Authorization in jwt mode and returns a blob', async () => {
      setAccessToken('access-token-123');
      const blob = new Blob(['pdf-bytes'], { type: 'application/pdf' });
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        blob: async () => blob,
      } as unknown as Response);

      const result = await apiFetchBlob('/books/book-1/pdf/preview');

      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer access-token-123');
      expect(result).toBe(blob);
    });
  });
});
