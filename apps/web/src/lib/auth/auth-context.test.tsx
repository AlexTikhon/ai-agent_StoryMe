import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider, useAuth } from './auth-context';
import { getAccessToken, setAccessToken } from './token-store';
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

function mockUnauthorized(): Response {
  return {
    ok: false,
    status: 401,
    json: async () => ({ message: 'Unauthorized' }),
  } as unknown as Response;
}

function Probe() {
  const { user, status, login, register, logout } = useAuth();
  return (
    <div>
      <p data-testid="status">{status}</p>
      <p data-testid="email">{user?.email ?? 'none'}</p>
      <button onClick={() => void login('emma@example.com', 'Passw0rd!')}>login</button>
      <button onClick={() => void register('emma@example.com', 'Passw0rd!', 'Emma')}>
        register
      </button>
      <button onClick={() => void logout()}>logout</button>
    </div>
  );
}

describe('AuthProvider', () => {
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

  describe('jwt mode', () => {
    it('restores the session on load via the silent refresh-on-401 flow', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(mockUnauthorized()) // GET /auth/me (no token yet)
        .mockResolvedValueOnce(mockOk({ accessToken: 'tok1', user: MOCK_USER })) // POST /auth/refresh
        .mockResolvedValueOnce(mockOk(MOCK_USER)); // retried GET /auth/me

      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('status').textContent).toBe('authed');
        expect(screen.getByTestId('email').textContent).toBe('emma@example.com');
      });
      expect(getAccessToken()).toBe('tok1');
    });

    it('lands in anon state when there is no valid refresh cookie', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(mockUnauthorized()) // GET /auth/me
        .mockResolvedValueOnce(mockUnauthorized()); // POST /auth/refresh also fails

      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('status').textContent).toBe('anon');
        expect(screen.getByTestId('email').textContent).toBe('none');
      });
    });

    it('login() sets the access token and user, and marks status authed', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(mockUnauthorized()) // GET /auth/me
        .mockResolvedValueOnce(mockUnauthorized()); // POST /auth/refresh fails -> anon

      const user = userEvent.setup();
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anon'));

      vi.mocked(fetch).mockResolvedValueOnce(mockOk({ accessToken: 'tok2', user: MOCK_USER }));
      await user.click(screen.getByRole('button', { name: 'login' }));

      await waitFor(() => {
        expect(screen.getByTestId('status').textContent).toBe('authed');
        expect(screen.getByTestId('email').textContent).toBe('emma@example.com');
      });
      expect(getAccessToken()).toBe('tok2');
    });

    it('register() sets the access token and user, and marks status authed', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(mockUnauthorized())
        .mockResolvedValueOnce(mockUnauthorized());

      const user = userEvent.setup();
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anon'));

      vi.mocked(fetch).mockResolvedValueOnce(mockOk({ accessToken: 'tok3', user: MOCK_USER }));
      await user.click(screen.getByRole('button', { name: 'register' }));

      await waitFor(() => {
        expect(screen.getByTestId('status').textContent).toBe('authed');
      });
      expect(getAccessToken()).toBe('tok3');
    });

    it('logout() clears the access token and user, and marks status anon', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(mockUnauthorized())
        .mockResolvedValueOnce(mockOk({ accessToken: 'tok1', user: MOCK_USER }))
        .mockResolvedValueOnce(mockOk(MOCK_USER));

      const user = userEvent.setup();
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authed'));

      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 204 } as Response);
      await user.click(screen.getByRole('button', { name: 'logout' }));

      await waitFor(() => {
        expect(screen.getByTestId('status').textContent).toBe('anon');
        expect(screen.getByTestId('email').textContent).toBe('none');
      });
      expect(getAccessToken()).toBeNull();
    });
  });

  describe('dev mode', () => {
    beforeEach(() => {
      process.env['NEXT_PUBLIC_AUTH_MODE'] = 'dev';
    });

    it('is authed immediately using dev headers, without attempting a refresh', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(MOCK_USER)); // GET /auth/me via x-user-email

      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('status').textContent).toBe('authed');
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('stays authed after logout (no real session to end in dev mode)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(MOCK_USER));

      const user = userEvent.setup();
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authed'));

      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 204 } as Response);
      await user.click(screen.getByRole('button', { name: 'logout' }));

      await waitFor(() => {
        expect(screen.getByTestId('status').textContent).toBe('authed');
      });
    });
  });
});
