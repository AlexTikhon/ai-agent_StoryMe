import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useSearchParams } from 'next/navigation';
import BillingSuccessPage from './page';
import { billingApi } from '@/lib/api/billing';
import { CREDITS_UPDATED_EVENT } from '@/lib/credits-events';
import type { CheckoutGrantStatusDto } from '@book/types';

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

vi.mock('@/lib/api/billing', () => ({
  billingApi: { getCheckoutStatus: vi.fn() },
}));

function withSessionId(sessionId: string | null) {
  vi.mocked(useSearchParams).mockReturnValue({
    get: (key: string) => (key === 'session_id' ? sessionId : null),
  } as unknown as ReturnType<typeof useSearchParams>);
}

describe('BillingSuccessPage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('makes no API request and shows an error for a missing session_id', () => {
    withSessionId(null);

    render(<BillingSuccessPage />);

    expect(screen.getByRole('alert').textContent).toMatch(/couldn.t find your checkout session/i);
    expect(billingApi.getCheckoutStatus).not.toHaveBeenCalled();
  });

  it('makes no API request and shows an error for a malformed session_id', () => {
    withSessionId('<script>alert(1)</script>');

    render(<BillingSuccessPage />);

    expect(screen.getByRole('alert')).toBeDefined();
    expect(billingApi.getCheckoutStatus).not.toHaveBeenCalled();
  });

  it('polls pending then transitions to credited, notifying credits-updated, and stops polling', async () => {
    withSessionId('cs_test_123');
    const pending: CheckoutGrantStatusDto = { status: 'pending' };
    const credited: CheckoutGrantStatusDto = {
      status: 'credited',
      creditsGranted: 10,
      balance: 13,
    };
    vi.mocked(billingApi.getCheckoutStatus)
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(credited);

    const onCreditsUpdated = vi.fn();
    window.addEventListener(CREDITS_UPDATED_EVENT, onCreditsUpdated);

    render(<BillingSuccessPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('status').textContent).toMatch(/confirming your purchase/i);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(screen.getByText(/payment confirmed/i)).toBeDefined();
    expect(screen.getByText(/10 credits added/i)).toBeDefined();
    expect(screen.getByText(/new balance: 13 credits/i)).toBeDefined();
    expect(onCreditsUpdated).toHaveBeenCalledTimes(1);

    const callsAfterCredit = vi.mocked(billingApi.getCheckoutStatus).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    // Polling stopped once credited — no further calls.
    expect(vi.mocked(billingApi.getCheckoutStatus).mock.calls.length).toBe(callsAfterCredit);

    window.removeEventListener(CREDITS_UPDATED_EVENT, onCreditsUpdated);
  });

  it('stops polling on unmount', async () => {
    withSessionId('cs_test_123');
    vi.mocked(billingApi.getCheckoutStatus).mockResolvedValue({ status: 'pending' });

    const { unmount } = render(<BillingSuccessPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsBeforeUnmount = vi.mocked(billingApi.getCheckoutStatus).mock.calls.length;

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(vi.mocked(billingApi.getCheckoutStatus).mock.calls.length).toBe(callsBeforeUnmount);
  });

  it('shows a timeout state (not a payment-failed claim) after the bounded total polling time elapses', async () => {
    withSessionId('cs_test_123');
    vi.mocked(billingApi.getCheckoutStatus).mockResolvedValue({ status: 'pending' });

    render(<BillingSuccessPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(62_000);
    });

    expect(screen.getByText(/taking longer than expected/i)).toBeDefined();
    expect(screen.queryByText(/payment failed/i)).toBeNull();
    expect(screen.getByRole('button', { name: /check again/i })).toBeDefined();
  });
});
