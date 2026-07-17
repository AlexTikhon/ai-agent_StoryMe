import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { Env } from '../config/env.schema';

export const STRIPE_CLIENT_TOKEN = 'STRIPE_CLIENT_TOKEN';

/**
 * Resolves to a real Stripe client only when STRIPE_BILLING_ENABLED=true and
 * STRIPE_SECRET_KEY is configured — otherwise `null`, so BillingService can
 * fail closed (BILLING_DISABLED) without ever constructing a Stripe client
 * or making a network call. env.schema.ts's superRefine already guarantees
 * STRIPE_SECRET_KEY is present whenever STRIPE_BILLING_ENABLED=true, so the
 * `null` case here is only ever the disabled path.
 */
export const stripeClientProvider: Provider = {
  provide: STRIPE_CLIENT_TOKEN,
  useFactory: (config: ConfigService<Env, true>): Stripe | null => {
    const enabled = config.get('STRIPE_BILLING_ENABLED', { infer: true }) === 'true';
    const secretKey = config.get('STRIPE_SECRET_KEY', { infer: true });
    if (!enabled || !secretKey) return null;
    return new Stripe(secretKey);
  },
  inject: [ConfigService],
};
