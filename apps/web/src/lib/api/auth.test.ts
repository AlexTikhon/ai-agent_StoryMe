import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { authApi } from './auth';
import { UserRole } from '@book/types';
import type { UserDto } from '@book/types';

const MOCK_USER: UserDto = {
  id: 'user-1',
  email: 'emma@example.com',
  name: 'Emma',
  role: UserRole.User,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

function mockOk(body: unknown, status = 200): Response {
  return { ok: true, status, json: async () => body } as unknown as Response;
}

function mockError(status: number, message: string): Response {
  return { ok: false, status, json: async () => ({ message }) } as unknown as Response;
}

describe('authApi', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('register()', () => {
    it('sends POST /auth/register with credentials included and the request body', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockOk({ accessToken: 'tok', user: MOCK_USER }));

      const result = await authApi.register('emma@example.com', 'Passw0rd!', 'Emma');

      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/auth/register');
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('include');
      expect(JSON.parse(init.body as string)).toEqual({
        email: 'emma@example.com',
        password: 'Passw0rd!',
        name: 'Emma',
      });
      expect(result).toEqual({ accessToken: 'tok', user: MOCK_USER });
    });

    it('omits name from the body when not provided', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockOk({ accessToken: 'tok', user: MOCK_USER }));

      await authApi.register('emma@example.com', 'Passw0rd!');

      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual({
        email: 'emma@example.com',
        password: 'Passw0rd!',
      });
    });

    it('throws with the duplicate-email message on 409', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockError(409, 'Email is already registered'));

      await expect(authApi.register('emma@example.com', 'Passw0rd!')).rejects.toThrow(
        'Email is already registered',
      );
    });
  });

  describe('login()', () => {
    it('sends POST /auth/login with credentials included', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockOk({ accessToken: 'tok', user: MOCK_USER }));

      const result = await authApi.login('emma@example.com', 'Passw0rd!');

      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/auth/login');
      expect(init.credentials).toBe('include');
      expect(JSON.parse(init.body as string)).toEqual({
        email: 'emma@example.com',
        password: 'Passw0rd!',
      });
      expect(result.user).toEqual(MOCK_USER);
    });

    it('throws a generic invalid-credentials message on 401', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockError(401, 'Invalid email or password'));

      await expect(authApi.login('emma@example.com', 'wrong')).rejects.toThrow(
        'Invalid email or password',
      );
    });
  });

  describe('refresh()', () => {
    it('sends POST /auth/refresh with no body and credentials included', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockOk({ accessToken: 'tok2', user: MOCK_USER }));

      const result = await authApi.refresh();

      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/auth/refresh');
      expect(init.credentials).toBe('include');
      expect(init.body).toBeUndefined();
      expect(result.accessToken).toBe('tok2');
    });

    it('throws on 401 when the refresh cookie is missing or invalid', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockError(401, 'Missing refresh token'));

      await expect(authApi.refresh()).rejects.toThrow('Missing refresh token');
    });
  });

  describe('logout()', () => {
    it('sends POST /auth/logout with credentials included and resolves on 204', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 204 } as Response);

      await expect(authApi.logout()).resolves.toBeUndefined();

      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/auth/logout');
      expect(init.credentials).toBe('include');
    });
  });
});
