import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';
import RegisterPage from './page';
import { useAuth } from '@/lib/auth/auth-context';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
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
    vi.mocked(useAuth).mockReturnValue({
      user: null,
      status: 'anon',
      authMode: 'jwt',
      login: vi.fn(),
      register: registerMock,
      logout: vi.fn(),
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

  it('links to the login page', () => {
    render(<RegisterPage />);
    const link = screen.getByRole('link', { name: /sign in/i });
    expect(link.getAttribute('href')).toBe('/login');
  });
});
