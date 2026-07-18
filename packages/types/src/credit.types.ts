/** Mirrors the CreditReason enum in schema.prisma. */
export enum CreditReason {
  BookCreation = 'book_creation',
  RegenPage = 'regen_page',
  RefundGenerationFailure = 'refund_generation_failure',
  /** Phase G1: compensating credit for a user-initiated cancellation (POST /books/:id/cancel) — distinct from RefundGenerationFailure. */
  RefundGenerationCancelled = 'refund_generation_cancelled',
  Purchase = 'purchase',
  SubscriptionGrant = 'subscription_grant',
  PromotionalGrant = 'promotional_grant',
  AdminAdjustment = 'admin_adjustment',
}

/** Bounds for GET /api/credits/transactions?limit=. */
export const MIN_CREDIT_TRANSACTIONS_PAGE_SIZE = 1;
export const MAX_CREDIT_TRANSACTIONS_PAGE_SIZE = 100;
export const DEFAULT_CREDIT_TRANSACTIONS_PAGE_SIZE = 20;

/** Response from GET /api/credits/balance. */
export interface CreditBalanceDto {
  balance: number;
  creditsUpdatedAt: string | null;
}

/**
 * API-facing shape of a CreditTransaction — deliberately omits
 * stripePaymentId and idempotencyKey, neither of which is safe to expose to
 * the owning user.
 */
export interface CreditTransactionDto {
  id: string;
  bookId: string | null;
  amount: number;
  balanceAfter: number;
  reason: CreditReason;
  createdAt: string;
}

/** Filters GET /api/credits/transactions to only debits (amount < 0) or only credits (amount > 0); omitted returns both. */
export type CreditTransactionDirection = 'debit' | 'credit';

/** Cursor-paginated response for GET /api/credits/transactions. */
export interface CreditTransactionsPageDto {
  items: CreditTransactionDto[];
  /** Opaque cursor for the next page, or null when this is the last page. */
  nextCursor: string | null;
  limit: number;
}
