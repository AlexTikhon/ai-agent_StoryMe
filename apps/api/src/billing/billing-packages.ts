import type { CreditPackageId } from '@book/types';
import type { Env } from '../config/env.schema';

/**
 * Server-owned credit package catalog — the only source of truth for what a
 * package id costs in credits and which env var holds its Stripe Price ID.
 * A client request only ever supplies `packageId`; it never supplies a
 * Price ID, credit quantity, currency, or monetary amount (see
 * apps/api/docs/credits.md, "Phase E3").
 */
export interface CreditPackageDefinition {
  id: CreditPackageId;
  credits: number;
  priceIdEnvKey: keyof Env;
}

export const CREDIT_PACKAGES: readonly CreditPackageDefinition[] = [
  { id: 'starter', credits: 10, priceIdEnvKey: 'STRIPE_PRICE_ID_STARTER' },
  { id: 'pro', credits: 30, priceIdEnvKey: 'STRIPE_PRICE_ID_PRO' },
  { id: 'bundle', credits: 100, priceIdEnvKey: 'STRIPE_PRICE_ID_BUNDLE' },
];

export function findCreditPackageDefinition(
  packageId: string,
): CreditPackageDefinition | undefined {
  return CREDIT_PACKAGES.find((p) => p.id === packageId);
}
