import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { creditsApi } from './credits';
import { setAccessToken } from '../auth/token-store';
import type { CreditBalanceDto, CreditTransactionsPageDto } from '@book/types';
import { CreditReason } from '@book/types';

function mockOk(body: unknown, status = 200): Response {
  return { ok: true, status, json: async () => body } as unknown as Response;
}

function mockError(status: number, message: string): Response {
  return { ok: false, status, json: async () => ({ message }) } as unknown as Response;
}

describe('creditsApi', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    setAccessToken('access-token-123');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  describe('getBalance()', () => {
    it('sends GET /credits/balance with a Bearer token', async () => {
      const balance: CreditBalanceDto = { balance: 5, creditsUpdatedAt: null };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(balance));

      const result = await creditsApi.getBalance();

      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/credits/balance');
      expect((init.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer access-token-123',
      );
      expect(result).toEqual(balance);
    });

    it('propagates an API error', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockError(500, 'boom'));
      await expect(creditsApi.getBalance()).rejects.toThrow('boom');
    });
  });

  describe('getTransactions()', () => {
    it('sends GET /credits/transactions with no query params when none are given', async () => {
      const page: CreditTransactionsPageDto = { items: [], nextCursor: null, limit: 20 };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(page));

      const result = await creditsApi.getTransactions();

      expect(fetch).toHaveBeenCalledOnce();
      const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/credits/transactions');
      expect(result).toEqual(page);
    });

    it('forwards cursor, limit, and direction as query params', async () => {
      const page: CreditTransactionsPageDto = {
        items: [
          {
            id: 'tx-1',
            bookId: null,
            amount: 10,
            balanceAfter: 13,
            reason: CreditReason.Purchase,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: 'tx-1',
        limit: 5,
      };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(page));

      const result = await creditsApi.getTransactions({
        cursor: 'cursor-abc',
        limit: 5,
        direction: 'credit',
      });

      const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'http://localhost:4000/api/credits/transactions?cursor=cursor-abc&limit=5&direction=credit',
      );
      expect(result).toEqual(page);
    });
  });
});
