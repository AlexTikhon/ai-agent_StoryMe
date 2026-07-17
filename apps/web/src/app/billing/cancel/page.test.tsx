import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import BillingCancelPage from './page';
import { billingApi } from '@/lib/api/billing';

vi.mock('next/link', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, className }: any) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock('@/lib/api/billing', () => ({
  billingApi: { getCheckoutStatus: vi.fn(), createCheckout: vi.fn(), getPackages: vi.fn() },
}));

describe('BillingCancelPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('states checkout was cancelled and no credits were added, with a link back to credits', () => {
    render(<BillingCancelPage />);

    expect(screen.getByText(/checkout cancelled/i)).toBeDefined();
    expect(screen.getByText(/no credits were added/i)).toBeDefined();
    expect(screen.getByRole('link', { name: /back to credits/i })).toHaveProperty(
      'href',
      expect.stringContaining('/dashboard/credits'),
    );
  });

  it('makes no mutation request', () => {
    render(<BillingCancelPage />);

    expect(billingApi.getCheckoutStatus).not.toHaveBeenCalled();
    expect(billingApi.createCheckout).not.toHaveBeenCalled();
  });
});
