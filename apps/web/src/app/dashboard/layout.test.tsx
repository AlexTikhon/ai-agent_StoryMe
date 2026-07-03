import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter, usePathname } from 'next/navigation';
import DashboardLayout from './layout';
import { useAuth } from '@/lib/auth/auth-context';
import { authApi } from '@/lib/api/auth';
import { UserRole } from '@book/types';
import type { UserDto } from '@book/types';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  usePathname: vi.fn(),
}));

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/lib/api/auth', () => ({
  authApi: { resendVerification: vi.fn() },
}));

const MOCK_USER: UserDto = {
  id: 'user-1',
  email: 'emma@example.com',
  name: 'Emma',
  role: UserRole.User,
  emailVerified: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('DashboardLayout', () => {
  const pushMock = vi.fn();
  const replaceMock = vi.fn();
  const logoutMock = vi.fn();

  beforeEach(() => {
    pushMock.mockReset();
    replaceMock.mockReset();
    logoutMock.mockReset();
    vi.mocked(useRouter).mockReturnValue({
      push: pushMock,
      replace: replaceMock,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue('/dashboard');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('redirects to /login when unauthenticated in jwt mode', async () => {
    vi.mocked(useAuth).mockReturnValue({
      user: null,
      status: 'anon',
      authMode: 'jwt',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
    });

    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/login?next=%2Fdashboard');
    });
    expect(screen.queryByText('Protected content')).toBeNull();
  });

  it('renders children when authenticated in jwt mode', async () => {
    vi.mocked(useAuth).mockReturnValue({
      user: MOCK_USER,
      status: 'authed',
      authMode: 'jwt',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
    });

    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    expect(screen.getByText('Protected content')).toBeDefined();
    expect(replaceMock).not.toHaveBeenCalled();
    expect(screen.getByText(/emma@example.com/)).toBeDefined();
  });

  it('shows a loading state instead of redirecting while the session is being restored', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: null,
      status: 'loading',
      authMode: 'jwt',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
    });

    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    expect(screen.queryByText('Protected content')).toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('never redirects and always renders children in dev mode', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: null,
      status: 'anon',
      authMode: 'dev',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
    });

    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    expect(screen.getByText('Protected content')).toBeDefined();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('logout button calls logout() and redirects to /login', async () => {
    logoutMock.mockResolvedValueOnce(undefined);
    vi.mocked(useAuth).mockReturnValue({
      user: MOCK_USER,
      status: 'authed',
      authMode: 'jwt',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
    });

    const user = userEvent.setup();
    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    await user.click(screen.getByRole('button', { name: /log out/i }));

    await waitFor(() => {
      expect(logoutMock).toHaveBeenCalled();
      expect(pushMock).toHaveBeenCalledWith('/login');
    });
  });

  it('shows a verify-email banner with a resend action for an unverified jwt user', async () => {
    vi.mocked(authApi.resendVerification).mockResolvedValueOnce(undefined);
    vi.mocked(useAuth).mockReturnValue({
      user: { ...MOCK_USER, emailVerified: false },
      status: 'authed',
      authMode: 'jwt',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
    });

    const user = userEvent.setup();
    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    expect(screen.getByRole('status').textContent).toContain('verify your email');
    await user.click(screen.getByRole('button', { name: /resend verification email/i }));

    await waitFor(() => {
      expect(authApi.resendVerification).toHaveBeenCalledWith('emma@example.com');
    });
  });

  it('does not show the verify-email banner for a verified user', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: MOCK_USER,
      status: 'authed',
      authMode: 'jwt',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
    });

    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not render a logout button in dev mode', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: null,
      status: 'authed',
      authMode: 'dev',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
    });

    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    expect(screen.queryByRole('button', { name: /log out/i })).toBeNull();
  });
});
