import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch, apiFetchBlob } from './client';
import { setAccessToken } from '../auth/token-store';

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
    delete process.env['NEXT_PUBLIC_AUTH_MODE'];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessToken(null);
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
