import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CreditsPage from './page';
import { CreditReason } from '@book/types';
import type {
  CreditBalanceDto,
  CreditPackageCatalogDto,
  CreditTransactionsPageDto,
  CheckoutSessionDto,
} from '@book/types';

vi.mock('next/link', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, className }: any) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const BALANCE: CreditBalanceDto = { balance: 5, creditsUpdatedAt: '2024-01-01T00:00:00.000Z' };
const CATALOG: CreditPackageCatalogDto = {
  checkoutEnabled: true,
  packages: [
    { id: 'starter', credits: 10 },
    { id: 'pro', credits: 30 },
    { id: 'bundle', credits: 100 },
  ],
};
const EMPTY_TX_PAGE: CreditTransactionsPageDto = { items: [], nextCursor: null, limit: 20 };

function mockOk(body: unknown, status = 200): Response {
  return { ok: true, status, json: async () => body } as unknown as Response;
}

function mockError(status: number, message: string): Response {
  return { ok: false, status, json: async () => ({ message }) } as unknown as Response;
}

/** Routes each fetch() call by matching the URL against provided handlers. */
function routeFetch(handlers: { match: RegExp; handler: () => Response }[]) {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = String(input);
    const found = handlers.find((h) => h.match.test(url));
    if (!found) throw new Error(`Unhandled fetch: ${url}`);
    return found.handler();
  });
}

describe('CreditsPage', () => {
  let assignMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    assignMock = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign: assignMock },
      writable: true,
    });
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-1111-1111-111111111111');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── Balance ────────────────────────────────────────────────────────────────

  it('renders the credit balance once loaded', async () => {
    routeFetch([
      { match: /\/credits\/balance$/, handler: () => mockOk(BALANCE) },
      { match: /\/billing\/packages$/, handler: () => mockOk(CATALOG) },
      { match: /\/credits\/transactions/, handler: () => mockOk(EMPTY_TX_PAGE) },
    ]);

    render(<CreditsPage />);

    await waitFor(() => {
      expect(screen.getByText('5 credits')).toBeDefined();
    });
  });

  it('shows an accessible retry action when the balance fails to load', async () => {
    routeFetch([
      { match: /\/credits\/balance$/, handler: () => mockError(500, 'boom') },
      { match: /\/billing\/packages$/, handler: () => mockOk(CATALOG) },
      { match: /\/credits\/transactions/, handler: () => mockOk(EMPTY_TX_PAGE) },
    ]);

    render(<CreditsPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('boom');
    });

    routeFetch([
      { match: /\/credits\/balance$/, handler: () => mockOk(BALANCE) },
      { match: /\/billing\/packages$/, handler: () => mockOk(CATALOG) },
      { match: /\/credits\/transactions/, handler: () => mockOk(EMPTY_TX_PAGE) },
    ]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => {
      expect(screen.getByText('5 credits')).toBeDefined();
    });
  });

  // ── Packages / billing-disabled state ──────────────────────────────────────

  it('renders package cards with name and credit quantity', async () => {
    routeFetch([
      { match: /\/credits\/balance$/, handler: () => mockOk(BALANCE) },
      { match: /\/billing\/packages$/, handler: () => mockOk(CATALOG) },
      { match: /\/credits\/transactions/, handler: () => mockOk(EMPTY_TX_PAGE) },
    ]);

    render(<CreditsPage />);

    await waitFor(() => {
      expect(screen.getByText('Starter')).toBeDefined();
    });
    expect(screen.getByText('10 credits')).toBeDefined();
    expect(screen.getByText('30 credits')).toBeDefined();
    expect(screen.getByText('100 credits')).toBeDefined();
    expect(screen.getAllByRole('button', { name: /continue to secure checkout/i })).toHaveLength(3);
  });

  it('shows a disabled/unavailable state and no active checkout buttons when billing is disabled', async () => {
    const disabledCatalog: CreditPackageCatalogDto = { ...CATALOG, checkoutEnabled: false };
    routeFetch([
      { match: /\/credits\/balance$/, handler: () => mockOk(BALANCE) },
      { match: /\/billing\/packages$/, handler: () => mockOk(disabledCatalog) },
      { match: /\/credits\/transactions/, handler: () => mockOk(EMPTY_TX_PAGE) },
    ]);

    render(<CreditsPage />);

    await waitFor(() => {
      expect(screen.getByText(/isn.t available right now/i)).toBeDefined();
    });
    for (const button of screen.getAllByRole('button', { name: /continue to secure checkout/i })) {
      expect(button).toBeDisabled();
    }
  });

  // ── Checkout submission ──────────────────────────────────────────────────────

  it('redirects exactly once via window.location.assign after a successful checkout creation', async () => {
    const session: CheckoutSessionDto = {
      sessionId: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
    };
    routeFetch([
      { match: /\/credits\/balance$/, handler: () => mockOk(BALANCE) },
      { match: /\/billing\/packages$/, handler: () => mockOk(CATALOG) },
      { match: /\/credits\/transactions/, handler: () => mockOk(EMPTY_TX_PAGE) },
      { match: /\/billing\/checkout$/, handler: () => mockOk(session) },
    ]);

    render(<CreditsPage />);
    const user = userEvent.setup();
    const [starterButton] = await screen.findAllByRole('button', {
      name: /continue to secure checkout/i,
    });

    await user.click(starterButton!);

    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledTimes(1);
    });
    expect(assignMock).toHaveBeenCalledWith(session.url);

    const checkoutCall = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url).endsWith('/billing/checkout'));
    expect(checkoutCall).toBeDefined();
    const [, init] = checkoutCall as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(
      '11111111-1111-1111-1111-111111111111',
    );
  });

  it('does not redirect when the API returns a non-HTTPS checkout URL', async () => {
    const session: CheckoutSessionDto = {
      sessionId: 'cs_test_123',
      url: 'http://not-secure.example',
    };
    routeFetch([
      { match: /\/credits\/balance$/, handler: () => mockOk(BALANCE) },
      { match: /\/billing\/packages$/, handler: () => mockOk(CATALOG) },
      { match: /\/credits\/transactions/, handler: () => mockOk(EMPTY_TX_PAGE) },
      { match: /\/billing\/checkout$/, handler: () => mockOk(session) },
    ]);

    render(<CreditsPage />);
    const user = userEvent.setup();
    const [starterButton] = await screen.findAllByRole('button', {
      name: /continue to secure checkout/i,
    });

    await user.click(starterButton!);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/could not be started/i);
    });
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('does not redirect for a malformed (non-URL) checkout value', async () => {
    const session = { sessionId: 'cs_test_123', url: 'not-a-url' } as CheckoutSessionDto;
    routeFetch([
      { match: /\/credits\/balance$/, handler: () => mockOk(BALANCE) },
      { match: /\/billing\/packages$/, handler: () => mockOk(CATALOG) },
      { match: /\/credits\/transactions/, handler: () => mockOk(EMPTY_TX_PAGE) },
      { match: /\/billing\/checkout$/, handler: () => mockOk(session) },
    ]);

    render(<CreditsPage />);
    const user = userEvent.setup();
    const [starterButton] = await screen.findAllByRole('button', {
      name: /continue to secure checkout/i,
    });

    await user.click(starterButton!);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
    });
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('does not create two checkout requests on a rapid double-click', async () => {
    const session: CheckoutSessionDto = {
      sessionId: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
    };
    let checkoutCalls = 0;
    routeFetch([
      { match: /\/credits\/balance$/, handler: () => mockOk(BALANCE) },
      { match: /\/billing\/packages$/, handler: () => mockOk(CATALOG) },
      { match: /\/credits\/transactions/, handler: () => mockOk(EMPTY_TX_PAGE) },
      {
        match: /\/billing\/checkout$/,
        handler: () => {
          checkoutCalls += 1;
          return mockOk(session);
        },
      },
    ]);

    render(<CreditsPage />);
    const [starterButton] = await screen.findAllByRole('button', {
      name: /continue to secure checkout/i,
    });

    // Fire two clicks back-to-back without awaiting between them, simulating
    // a double-click racing the still-in-flight first submission.
    fireEvent.click(starterButton!);
    fireEvent.click(starterButton!);

    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledTimes(1);
    });
    expect(checkoutCalls).toBe(1);
  });

  it('shows accessible in-flight status text while creating the checkout session', async () => {
    let resolveCheckout: (() => void) | undefined;
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (/\/credits\/balance$/.test(url)) return mockOk(BALANCE);
      if (/\/billing\/packages$/.test(url)) return mockOk(CATALOG);
      if (/\/credits\/transactions/.test(url)) return mockOk(EMPTY_TX_PAGE);
      if (/\/billing\/checkout$/.test(url)) {
        return new Promise((resolve) => {
          resolveCheckout = () =>
            resolve(
              mockOk({
                sessionId: 'cs_test_123',
                url: 'https://checkout.stripe.com/c/pay/cs_test_123',
              }),
            );
        });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });

    render(<CreditsPage />);
    const user = userEvent.setup();
    const [starterButton] = await screen.findAllByRole('button', {
      name: /continue to secure checkout/i,
    });
    await user.click(starterButton!);

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/creating your secure checkout/i);
    });

    resolveCheckout?.();
    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledTimes(1);
    });
  });

  // ── Transaction history ──────────────────────────────────────────────────────

  it('renders transaction history with amount sign, reason label, and date', async () => {
    const page: CreditTransactionsPageDto = {
      items: [
        {
          id: 'tx-1',
          bookId: null,
          amount: -1,
          balanceAfter: 4,
          reason: CreditReason.BookCreation,
          createdAt: '2024-01-02T00:00:00.000Z',
        },
        {
          id: 'tx-2',
          bookId: null,
          amount: 10,
          balanceAfter: 14,
          reason: CreditReason.Purchase,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ],
      nextCursor: null,
      limit: 20,
    };
    routeFetch([
      { match: /\/credits\/balance$/, handler: () => mockOk(BALANCE) },
      { match: /\/billing\/packages$/, handler: () => mockOk(CATALOG) },
      { match: /\/credits\/transactions/, handler: () => mockOk(page) },
    ]);

    render(<CreditsPage />);

    await waitFor(() => {
      expect(screen.getByText('Book creation')).toBeDefined();
    });
    expect(screen.getByText('Credit purchase')).toBeDefined();
    expect(screen.getByText(/\(debit\)/)).toBeDefined();
    expect(screen.getByText(/\(credit\)/)).toBeDefined();
  });

  it('shows empty/loading/error states for transaction history', async () => {
    routeFetch([
      { match: /\/credits\/balance$/, handler: () => mockOk(BALANCE) },
      { match: /\/billing\/packages$/, handler: () => mockOk(CATALOG) },
      { match: /\/credits\/transactions/, handler: () => mockError(500, 'history down') },
    ]);

    render(<CreditsPage />);

    await waitFor(() => {
      expect(screen.getByText('history down')).toBeDefined();
    });
  });

  it('loads the next page via cursor pagination on "Load more"', async () => {
    const page1: CreditTransactionsPageDto = {
      items: [
        {
          id: 'tx-1',
          bookId: null,
          amount: -1,
          balanceAfter: 4,
          reason: CreditReason.BookCreation,
          createdAt: '2024-01-02T00:00:00.000Z',
        },
      ],
      nextCursor: 'tx-1',
      limit: 20,
    };
    const page2: CreditTransactionsPageDto = {
      items: [
        {
          id: 'tx-2',
          bookId: null,
          amount: 10,
          balanceAfter: 14,
          reason: CreditReason.Purchase,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ],
      nextCursor: null,
      limit: 20,
    };
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (/\/credits\/balance$/.test(url)) return mockOk(BALANCE);
      if (/\/billing\/packages$/.test(url)) return mockOk(CATALOG);
      if (/cursor=tx-1/.test(url)) return mockOk(page2);
      if (/\/credits\/transactions/.test(url)) return mockOk(page1);
      throw new Error(`Unhandled fetch: ${url}`);
    });

    render(<CreditsPage />);
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText('Book creation')).toBeDefined();
    });
    expect(screen.queryByText('Credit purchase')).toBeNull();

    await user.click(screen.getByRole('button', { name: /load more/i }));

    await waitFor(() => {
      expect(screen.getByText('Credit purchase')).toBeDefined();
    });
    // Both pages' items remain visible — Load More appends, it doesn't replace.
    expect(screen.getByText('Book creation')).toBeDefined();
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });
});
