import type {
  CheckoutGrantStatusDto,
  CheckoutSessionDto,
  CreditPackageCatalogDto,
  CreditPackageId,
} from '@book/types';
import { apiFetch } from './client';

export const billingApi = {
  getPackages: (): Promise<CreditPackageCatalogDto> => apiFetch('/billing/packages'),

  /** `idempotencyKey` must be a fresh `crypto.randomUUID()` per distinct purchase attempt — see CreditsPage, which reuses one key while a submission is in flight and mints a new one for the next. */
  createCheckout: (
    packageId: CreditPackageId,
    idempotencyKey: string,
  ): Promise<CheckoutSessionDto> =>
    apiFetch('/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ packageId }),
      headers: { 'Idempotency-Key': idempotencyKey },
    }),

  getCheckoutStatus: (sessionId: string): Promise<CheckoutGrantStatusDto> =>
    apiFetch(`/billing/checkout/${encodeURIComponent(sessionId)}/status`),
};
