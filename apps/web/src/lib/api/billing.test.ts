import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { billingApi } from './billing';
import { setAccessToken } from '../auth/token-store';
import type {
  CheckoutGrantStatusDto,
  CheckoutSessionDto,
  CreditPackageCatalogDto,
} from '@book/types';

function mockOk(body: unknown, status = 200): Response {
  return { ok: true, status, json: async () => body } as unknown as Response;
}

function mockError(status: number, message: string, code?: string): Response {
  return { ok: false, status, json: async () => ({ message, code }) } as unknown as Response;
}

describe('billingApi', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    setAccessToken('access-token-123');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  describe('getPackages()', () => {
    it('sends GET /billing/packages with a Bearer token', async () => {
      const catalog: CreditPackageCatalogDto = {
        checkoutEnabled: true,
        packages: [{ id: 'starter', credits: 10 }],
      };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(catalog));

      const result = await billingApi.getPackages();

      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/billing/packages');
      expect((init.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer access-token-123',
      );
      expect(result).toEqual(catalog);
    });
  });

  describe('createCheckout()', () => {
    it('sends POST /billing/checkout with the packageId body and Idempotency-Key header', async () => {
      const session: CheckoutSessionDto = {
        sessionId: 'cs_test_123',
        url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(session));

      const result = await billingApi.createCheckout('starter', 'idem-key-abc');

      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/billing/checkout');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ packageId: 'starter' });
      expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('idem-key-abc');
      expect(result).toEqual(session);
    });

    it('propagates a safe API error (e.g. BILLING_DISABLED) with its code', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        mockError(503, 'Billing is not available', 'BILLING_DISABLED'),
      );

      await expect(billingApi.createCheckout('starter', 'idem-key-abc')).rejects.toMatchObject({
        message: 'Billing is not available',
        code: 'BILLING_DISABLED',
      });
    });
  });

  describe('getCheckoutStatus()', () => {
    it('sends GET /billing/checkout/:sessionId/status with the session id URL-encoded', async () => {
      const status: CheckoutGrantStatusDto = { status: 'pending' };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(status));

      const result = await billingApi.getCheckoutStatus('cs_test_123');

      const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/billing/checkout/cs_test_123/status');
      expect(result).toEqual(status);
    });

    it('returns a credited status with granted credits and balance', async () => {
      const status: CheckoutGrantStatusDto = {
        status: 'credited',
        creditsGranted: 10,
        balance: 13,
      };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(status));

      const result = await billingApi.getCheckoutStatus('cs_test_123');

      expect(result).toEqual(status);
    });
  });
});
