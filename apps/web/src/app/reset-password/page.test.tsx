import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSearchParams } from 'next/navigation';
import ResetPasswordPage from './page';
import { authApi } from '@/lib/api/auth';

vi.mock('next/navigation', () => ({
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

vi.mock('@/lib/api/auth', () => ({
  authApi: { resetPassword: vi.fn() },
}));

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    vi.mocked(authApi.resetPassword).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows a success state and a link to sign in once the password is reset', async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams('token=raw-token') as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(authApi.resetPassword).mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<ResetPasswordPage />);

    await user.type(screen.getByLabelText(/new password/i), 'NewPassword1');
    await user.type(screen.getByLabelText(/confirm password/i), 'NewPassword1');
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    await waitFor(() => {
      expect(authApi.resetPassword).toHaveBeenCalledWith('raw-token', 'NewPassword1');
      expect(screen.getByText(/password reset/i)).toBeDefined();
      expect(screen.getByRole('link', { name: /go to sign in/i })).toBeDefined();
    });
  });

  it('shows an error for a mismatched confirmation without calling the API', async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams('token=raw-token') as unknown as ReturnType<typeof useSearchParams>,
    );
    const user = userEvent.setup();
    render(<ResetPasswordPage />);

    await user.type(screen.getByLabelText(/new password/i), 'NewPassword1');
    await user.type(screen.getByLabelText(/confirm password/i), 'Different1');
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Passwords do not match');
    });
    expect(authApi.resetPassword).not.toHaveBeenCalled();
  });

  it('shows an error message for an invalid/expired token', async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams('token=bogus') as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(authApi.resetPassword).mockRejectedValueOnce(
      new Error('Invalid or expired reset token'),
    );
    const user = userEvent.setup();
    render(<ResetPasswordPage />);

    await user.type(screen.getByLabelText(/new password/i), 'NewPassword1');
    await user.type(screen.getByLabelText(/confirm password/i), 'NewPassword1');
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Invalid or expired reset token');
    });
  });

  it('shows a missing-token error state immediately when no token is present in the URL', () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );

    render(<ResetPasswordPage />);

    expect(screen.getByRole('alert').textContent).toContain('Missing reset token');
    expect(screen.getByRole('link', { name: /request a new reset link/i })).toBeDefined();
  });
});
