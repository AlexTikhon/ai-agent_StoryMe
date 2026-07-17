/**
 * Server-owned credit package catalog ids (Phase E3) — see
 * apps/api/src/billing/billing-packages.ts for credit amounts and the
 * Stripe Price ID each maps to. A client only ever supplies one of these
 * ids; it never supplies a Price ID, credit quantity, currency, or amount.
 */
export type CreditPackageId = 'starter' | 'pro' | 'bundle';

/** Request body for POST /api/billing/checkout. */
export interface CreateCheckoutRequest {
  packageId: CreditPackageId;
}

/** Response from POST /api/billing/checkout — the hosted Stripe Checkout URL and session id, nothing else. */
export interface CheckoutSessionDto {
  sessionId: string;
  url: string;
}
