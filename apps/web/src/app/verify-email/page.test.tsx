import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useSearchParams } from 'next/navigation';
import VerifyEmailPage from './page';
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
  authApi: { verifyEmail: vi.fn() },
}));

describe('VerifyEmailPage', () => {
  beforeEach(() => {
    vi.mocked(authApi.verifyEmail).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows a success message once verification succeeds', async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams('token=raw-token') as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(authApi.verifyEmail).mockResolvedValueOnce(undefined);

    render(<VerifyEmailPage />);

    expect(screen.getByText(/verifying your email/i)).toBeDefined();
    await waitFor(() => {
      expect(authApi.verifyEmail).toHaveBeenCalledWith('raw-token');
      expect(screen.getByText(/email verified/i)).toBeDefined();
    });
  });

  it('shows an error message for an invalid/expired token', async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams('token=bogus') as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(authApi.verifyEmail).mockRejectedValueOnce(
      new Error('Invalid or expired verification token'),
    );

    render(<VerifyEmailPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'Invalid or expired verification token',
      );
    });
  });

  it('shows an error message immediately when no token is present in the URL', async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );

    render(<VerifyEmailPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Missing verification token');
    });
    expect(authApi.verifyEmail).not.toHaveBeenCalled();
  });
});
