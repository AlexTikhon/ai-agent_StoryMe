import { describe, it, expect } from 'vitest';
import { CREDIT_PACKAGES, findCreditPackageDefinition } from './billing-packages';

describe('billing-packages', () => {
  it('defines exactly the starter/pro/bundle catalog with their documented credit amounts', () => {
    expect(CREDIT_PACKAGES).toEqual([
      { id: 'starter', credits: 10, priceIdEnvKey: 'STRIPE_PRICE_ID_STARTER' },
      { id: 'pro', credits: 30, priceIdEnvKey: 'STRIPE_PRICE_ID_PRO' },
      { id: 'bundle', credits: 100, priceIdEnvKey: 'STRIPE_PRICE_ID_BUNDLE' },
    ]);
  });

  it('findCreditPackageDefinition resolves each known id', () => {
    expect(findCreditPackageDefinition('starter')?.credits).toBe(10);
    expect(findCreditPackageDefinition('pro')?.credits).toBe(30);
    expect(findCreditPackageDefinition('bundle')?.credits).toBe(100);
  });

  it('findCreditPackageDefinition returns undefined for an unknown id', () => {
    expect(findCreditPackageDefinition('enterprise')).toBeUndefined();
    expect(findCreditPackageDefinition('')).toBeUndefined();
    expect(findCreditPackageDefinition('STARTER')).toBeUndefined();
  });
});
