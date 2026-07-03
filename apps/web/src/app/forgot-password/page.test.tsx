import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ForgotPasswordPage from './page';
import { authApi } from '@/lib/api/auth';

vi.mock('next/link', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, className }: any) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock('@/lib/api/auth', () => ({
  authApi: { requestPasswordReset: vi.fn() },
}));

describe('ForgotPasswordPage', () => {
  beforeEach(() => {
    vi.mocked(authApi.requestPasswordReset).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows a generic success message for an existing email', async () => {
    vi.mocked(authApi.requestPasswordReset).mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<ForgotPasswordPage />);

    await user.type(screen.getByLabelText(/email/i), 'emma@example.com');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => {
      expect(authApi.requestPasswordReset).toHaveBeenCalledWith('emma@example.com');
      expect(screen.getByRole('status').textContent).toContain(
        'If an account exists for this email, a reset link has been sent.',
      );
    });
  });

  it('shows the identical generic success message for an unknown email', async () => {
    vi.mocked(authApi.requestPasswordReset).mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<ForgotPasswordPage />);

    await user.type(screen.getByLabelText(/email/i), 'nobody@example.com');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain(
        'If an account exists for this email, a reset link has been sent.',
      );
    });
  });

  it('shows an error message when the request itself fails (e.g. rate limited)', async () => {
    vi.mocked(authApi.requestPasswordReset).mockRejectedValueOnce(new Error('Too many requests'));
    const user = userEvent.setup();
    render(<ForgotPasswordPage />);

    await user.type(screen.getByLabelText(/email/i), 'emma@example.com');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Too many requests');
    });
  });

  it('links back to the login page', () => {
    render(<ForgotPasswordPage />);
    const link = screen.getByRole('link', { name: /back to sign in/i });
    expect(link.getAttribute('href')).toBe('/login');
  });
});
