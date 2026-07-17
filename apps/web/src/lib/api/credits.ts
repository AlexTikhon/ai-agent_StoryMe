import type {
  CreditBalanceDto,
  CreditTransactionDirection,
  CreditTransactionsPageDto,
} from '@book/types';
import { apiFetch } from './client';

export interface GetTransactionsParams {
  cursor?: string;
  limit?: number;
  direction?: CreditTransactionDirection;
}

export const creditsApi = {
  getBalance: (): Promise<CreditBalanceDto> => apiFetch('/credits/balance'),

  getTransactions: (params: GetTransactionsParams = {}): Promise<CreditTransactionsPageDto> => {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit != null) query.set('limit', String(params.limit));
    if (params.direction) query.set('direction', params.direction);
    const qs = query.toString();
    return apiFetch(`/credits/transactions${qs ? `?${qs}` : ''}`);
  },
};
