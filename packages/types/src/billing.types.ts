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

/**
 * One purchasable package as exposed to a client — deliberately omits the
 * Stripe Price ID (see CreditPackageDefinition in billing-packages.ts) and
 * never carries a monetary amount/currency; the frontend shows the credit
 * quantity only ("10 credits") and lets Stripe Checkout itself present price.
 */
export interface CreditPackageSummaryDto {
  id: CreditPackageId;
  credits: number;
}

/** Response from GET /api/billing/packages. */
export interface CreditPackageCatalogDto {
  /** False when Stripe billing is disabled/unconfigured — the UI should show a clear unavailable state rather than a broken checkout button. */
  checkoutEnabled: boolean;
  packages: CreditPackageSummaryDto[];
}

/**
 * Response from GET /api/billing/checkout/:sessionId/status — reports
 * durable local grant state only (never a Stripe network call, never
 * revealing whether a session belongs to another user; an unowned or
 * unknown session both resolve to 'pending').
 */
export type CheckoutGrantStatusDto =
  { status: 'pending' } | { status: 'credited'; creditsGranted: number; balance: number };
