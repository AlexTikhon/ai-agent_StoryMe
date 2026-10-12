import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter, useSearchParams } from 'next/navigation';
import RegisterPage from './page';
import { useAuth } from '@/lib/auth/auth-context';

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

describe('RegisterPage', () => {
  const pushMock = vi.fn();
  const replaceMock = vi.fn();
  const registerMock = vi.fn();

  beforeEach(() => {
    pushMock.mockReset();
    replaceMock.mockReset();
    registerMock.mockReset();
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
      login: vi.fn(),
      register: registerMock,
      logout: vi.fn(),
      retrySession: vi.fn(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers with valid input and redirects to /dashboard', async () => {
    registerMock.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<RegisterPage />);

    await user.type(screen.getByLabelText(/name/i), 'Emma');
    await user.type(screen.getByLabelText(/email/i), 'emma@example.com');
    await user.type(screen.getByLabelText(/password/i), 'Passw0rd!');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(registerMock).toHaveBeenCalledWith('emma@example.com', 'Passw0rd!', 'Emma');
      expect(pushMock).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('registers without a name when the optional field is left blank', async () => {
    registerMock.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<RegisterPage />);

    await user.type(screen.getByLabelText(/email/i), 'emma@example.com');
    await user.type(screen.getByLabelText(/password/i), 'Passw0rd!');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(registerMock).toHaveBeenCalledWith('emma@example.com', 'Passw0rd!', undefined);
    });
  });

  it('shows an error message on duplicate email', async () => {
    registerMock.mockRejectedValueOnce(new Error('Email is already registered'));
    const user = userEvent.setup();
    render(<RegisterPage />);

    await user.type(screen.getByLabelText(/email/i), 'emma@example.com');
    await user.type(screen.getByLabelText(/password/i), 'Passw0rd!');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Email is already registered');
    });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('shows a validation error message from the API for a weak password', async () => {
    registerMock.mockRejectedValueOnce(
      new Error('password must contain at least one uppercase letter'),
    );
    const user = userEvent.setup();
    render(<RegisterPage />);

    await user.type(screen.getByLabelText(/email/i), 'emma@example.com');
    await user.type(screen.getByLabelText(/password/i), 'weakpass1');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('uppercase');
    });
  });

  const searchWith = (query: string) =>
    vi
      .mocked(useSearchParams)
      .mockReturnValue(new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>);

  const fillAndSubmit = async () => {
    const user = userEvent.setup();
    render(<RegisterPage />);
    await user.type(screen.getByLabelText(/email/i), 'emma@example.com');
    await user.type(screen.getByLabelText(/password/i), 'Passw0rd!');
    await user.click(screen.getByRole('button', { name: /create account/i }));
  };

  it('redirects to the validated ?next= destination after registering', async () => {
    registerMock.mockResolvedValueOnce(undefined);
    searchWith('next=/dashboard/interactive');
    await fillAndSubmit();
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/dashboard/interactive');
    });
  });

  it.each(['https://evil.example/dashboard', '//evil.example', '/login', '/dashboard/../login'])(
    'falls back to /dashboard for the unsafe ?next=%s',
    async (next) => {
      registerMock.mockResolvedValueOnce(undefined);
      searchWith(new URLSearchParams({ next }).toString());
      await fillAndSubmit();
      await waitFor(() => {
        expect(pushMock).toHaveBeenCalledWith('/dashboard');
      });
    },
  );

  it('redirects an already-authenticated visitor to the validated ?next= path', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: null,
      status: 'authed',
      authMode: 'jwt',
      login: vi.fn(),
      register: registerMock,
      logout: vi.fn(),
      retrySession: vi.fn(),
    });
    searchWith('next=/dashboard/interactive');
    render(<RegisterPage />);
    expect(replaceMock).toHaveBeenCalledWith('/dashboard/interactive');
  });

  it('preserves a valid ?next= destination on the sign-in link', () => {
    searchWith('next=/dashboard/interactive');
    render(<RegisterPage />);
    expect(screen.getByRole('link', { name: /sign in/i }).getAttribute('href')).toBe(
      '/login?next=%2Fdashboard%2Finteractive',
    );
  });

  it('drops an unsafe ?next= from the sign-in link', () => {
    searchWith('next=//evil.example');
    render(<RegisterPage />);
    expect(screen.getByRole('link', { name: /sign in/i }).getAttribute('href')).toBe('/login');
  });

  it('links to the login page', () => {
    render(<RegisterPage />);
    const link = screen.getByRole('link', { name: /sign in/i });
    expect(link.getAttribute('href')).toBe('/login');
  });
});
