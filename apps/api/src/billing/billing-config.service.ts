import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CreditPackageId } from '@book/types';
import type { Env } from '../config/env.schema';
import { CREDIT_PACKAGES, findCreditPackageDefinition } from './billing-packages';

/** A catalog package resolved against live env config — its Stripe Price ID is always present, never optional, once resolved. */
export interface ResolvedCreditPackage {
  id: CreditPackageId;
  credits: number;
  priceId: string;
}

/**
 * Single place that turns the static CREDIT_PACKAGES catalog and Stripe env
 * vars into config BillingService can act on — never exposes
 * STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET themselves (see
 * apps/api/docs/credits.md, "Phase E3").
 */
@Injectable()
export class BillingConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  isEnabled(): boolean {
    return this.config.get('STRIPE_BILLING_ENABLED', { infer: true }) === 'true';
  }

  getWebAppUrl(): string {
    return this.config.get('WEB_APP_URL', { infer: true });
  }

  getWebhookSecret(): string | undefined {
    return this.config.get('STRIPE_WEBHOOK_SECRET', { infer: true });
  }

  /**
   * Resolves a client-supplied package id against the server-owned catalog.
   * Returns undefined for an unknown id, or for a known id whose Price ID
   * env var isn't configured (env.schema.ts's superRefine already refuses to
   * boot in that state when STRIPE_BILLING_ENABLED=true, but this stays
   * defensive rather than ever falling back to an empty/undefined Price ID).
   */
  getPackage(packageId: string): ResolvedCreditPackage | undefined {
    const definition = findCreditPackageDefinition(packageId);
    if (!definition) return undefined;
    const priceId = this.config.get(definition.priceIdEnvKey, { infer: true }) as
      string | undefined;
    if (!priceId) return undefined;
    return { id: definition.id, credits: definition.credits, priceId };
  }

  /** Every catalog package resolved against live config — skips any package whose Price ID isn't configured. */
  getAllPackages(): ResolvedCreditPackage[] {
    return CREDIT_PACKAGES.map((p) => this.getPackage(p.id)).filter(
      (p): p is ResolvedCreditPackage => p !== undefined,
    );
  }
}
