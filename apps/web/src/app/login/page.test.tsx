import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter, useSearchParams } from 'next/navigation';
import LoginPage from './page';
import { useAuth } from '@/lib/auth/auth-context';
import { ApiError } from '@/lib/api/api-error';
import { authApi } from '@/lib/api/auth';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

vi.mock('next/link', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, className }: any) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/lib/api/auth', () => ({
  authApi: { resendVerification: vi.fn() },
}));

describe('LoginPage', () => {
  const pushMock = vi.fn();
  const replaceMock = vi.fn();
  const loginMock = vi.fn();

  beforeEach(() => {
    pushMock.mockReset();
    replaceMock.mockReset();
    loginMock.mockReset();
    vi.mocked(useRouter).mockReturnValue({
      push: pushMock,
      replace: replaceMock,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useAuth).mockReturnValue({
      user: null,
      status: 'anon',
      authMode: 'jwt',
      login: loginMock,
      register: vi.fn(),
      logout: vi.fn(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('signs in with valid credentials and redirects to /dashboard', async () => {
    loginMock.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), 'emma@example.com');
    await user.type(screen.getByLabelText(/password/i), 'Passw0rd!');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(loginMock).toHaveBeenCalledWith('emma@example.com', 'Passw0rd!');
      expect(pushMock).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('redirects to the ?next= path after a successful login', async () => {
    loginMock.mockResolvedValueOnce(undefined);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams('next=/dashboard/books/new') as unknown as ReturnType<
        typeof useSearchParams
      >,
    );
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), 'emma@example.com');
    await user.type(screen.getByLabelText(/password/i), 'Passw0rd!');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/dashboard/books/new');
    });
  });

  it('shows an error message on invalid credentials', async () => {
    loginMock.mockRejectedValueOnce(new Error('Invalid email or password'));
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), 'emma@example.com');
    await user.type(screen.getByLabelText(/password/i), 'wrong-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Invalid email or password');
    });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('shows a verify-your-email message and a resend action on EMAIL_NOT_VERIFIED', async () => {
    loginMock.mockRejectedValueOnce(
      new ApiError(401, 'Email is not verified', 'EMAIL_NOT_VERIFIED'),
    );
    vi.mocked(authApi.resendVerification).mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), 'emma@example.com');
    await user.type(screen.getByLabelText(/password/i), 'Passw0rd!');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('verify your email');
    });
    expect(pushMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /resend verification email/i }));

    await waitFor(() => {
      expect(authApi.resendVerification).toHaveBeenCalledWith('emma@example.com');
      expect(screen.getByText(/verification email sent/i)).toBeDefined();
    });
  });

  it('links to the register page', () => {
    render(<LoginPage />);
    const link = screen.getByRole('link', { name: /register/i });
    expect(link.getAttribute('href')).toBe('/register');
  });
});
