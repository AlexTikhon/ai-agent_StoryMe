import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { authApi } from './auth';
import { ApiError } from './api-error';
import { UserRole } from '@book/types';
import type { UserDto } from '@book/types';

const MOCK_USER: UserDto = {
  id: 'user-1',
  email: 'emma@example.com',
  name: 'Emma',
  role: UserRole.User,
  emailVerified: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

function mockOk(body: unknown, status = 200): Response {
  return { ok: true, status, json: async () => body } as unknown as Response;
}

function mockError(status: number, message: string, code?: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({ message, ...(code ? { code } : {}) }),
  } as unknown as Response;
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

    it('surfaces the EMAIL_NOT_VERIFIED code on an unverified account', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        mockError(401, 'Email is not verified', 'EMAIL_NOT_VERIFIED'),
      );

      const error = await authApi
        .login('emma@example.com', 'Passw0rd!')
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('EMAIL_NOT_VERIFIED');
    });
  });

  describe('verifyEmail()', () => {
    it('sends POST /auth/verify-email with the token', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockOk({ verified: true }));

      await authApi.verifyEmail('raw-token');

      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/auth/verify-email');
      expect(JSON.parse(init.body as string)).toEqual({ token: 'raw-token' });
    });

    it('throws with the EMAIL_VERIFICATION error code on invalid/expired token', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        mockError(400, 'Invalid or expired verification token'),
      );

      await expect(authApi.verifyEmail('bogus')).rejects.toThrow(
        'Invalid or expired verification token',
      );
    });
  });

  describe('resendVerification()', () => {
    it('sends POST /auth/resend-verification with the email and resolves on 204', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 204 } as Response);

      await expect(authApi.resendVerification('emma@example.com')).resolves.toBeUndefined();

      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/auth/resend-verification');
      expect(JSON.parse(init.body as string)).toEqual({ email: 'emma@example.com' });
    });
  });

  describe('requestPasswordReset()', () => {
    it('sends POST /auth/request-password-reset with the email', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockOk({ ok: true }));

      await authApi.requestPasswordReset('emma@example.com');

      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/auth/request-password-reset');
      expect(init.credentials).toBe('include');
      expect(JSON.parse(init.body as string)).toEqual({ email: 'emma@example.com' });
    });

    it('resolves the same generic way for an unknown email (server never distinguishes)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockOk({ ok: true }));

      await expect(authApi.requestPasswordReset('nobody@example.com')).resolves.toBeUndefined();
    });
  });

  describe('resetPassword()', () => {
    it('sends POST /auth/reset-password with the token and new password', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockOk({ ok: true }));

      await authApi.resetPassword('raw-reset-token', 'NewPassword1');

      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/auth/reset-password');
      expect(JSON.parse(init.body as string)).toEqual({
        token: 'raw-reset-token',
        password: 'NewPassword1',
      });
    });

    it('throws with the INVALID_RESET_TOKEN code for an invalid/expired token', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        mockError(400, 'Invalid or expired reset token', 'INVALID_RESET_TOKEN'),
      );

      const error = await authApi
        .resetPassword('bogus', 'NewPassword1')
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('INVALID_RESET_TOKEN');
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
