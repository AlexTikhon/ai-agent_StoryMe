import { describe, it, expect } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { BillingConfigService } from './billing-config.service';

function createConfig(values: Partial<Env>): ConfigService<Env, true> {
  return {
    get: (key: keyof Env) => values[key],
  } as unknown as ConfigService<Env, true>;
}

describe('BillingConfigService', () => {
  describe('isEnabled', () => {
    it('is false when STRIPE_BILLING_ENABLED is "false"', () => {
      const service = new BillingConfigService(createConfig({ STRIPE_BILLING_ENABLED: 'false' }));
      expect(service.isEnabled()).toBe(false);
    });

    it('is true only when STRIPE_BILLING_ENABLED is exactly "true"', () => {
      const service = new BillingConfigService(createConfig({ STRIPE_BILLING_ENABLED: 'true' }));
      expect(service.isEnabled()).toBe(true);
    });
  });

  describe('getPackage', () => {
    it('resolves a known package id to its credits and configured Price ID', () => {
      const service = new BillingConfigService(
        createConfig({
          STRIPE_BILLING_ENABLED: 'true',
          STRIPE_PRICE_ID_STARTER: 'price_starter_123',
          STRIPE_PRICE_ID_PRO: 'price_pro_123',
          STRIPE_PRICE_ID_BUNDLE: 'price_bundle_123',
        }),
      );

      expect(service.getPackage('starter')).toEqual({
        id: 'starter',
        credits: 10,
        priceId: 'price_starter_123',
      });
      expect(service.getPackage('pro')).toEqual({
        id: 'pro',
        credits: 30,
        priceId: 'price_pro_123',
      });
      expect(service.getPackage('bundle')).toEqual({
        id: 'bundle',
        credits: 100,
        priceId: 'price_bundle_123',
      });
    });

    it('returns undefined for an unknown package id (never throws)', () => {
      const service = new BillingConfigService(createConfig({}));
      expect(service.getPackage('enterprise')).toBeUndefined();
      expect(service.getPackage('')).toBeUndefined();
    });

    it('returns undefined for a known id whose Price ID env var is not configured', () => {
      const service = new BillingConfigService(
        createConfig({ STRIPE_BILLING_ENABLED: 'false' /* no price IDs set */ }),
      );
      expect(service.getPackage('starter')).toBeUndefined();
    });
  });

  describe('getAllPackages', () => {
    it('returns only packages whose Price ID is configured', () => {
      const service = new BillingConfigService(
        createConfig({ STRIPE_PRICE_ID_STARTER: 'price_starter_123' }),
      );
      const packages = service.getAllPackages();
      expect(packages).toEqual([{ id: 'starter', credits: 10, priceId: 'price_starter_123' }]);
    });
  });

  it('getWebAppUrl returns the configured WEB_APP_URL', () => {
    const service = new BillingConfigService(
      createConfig({ WEB_APP_URL: 'https://app.storyme.example' }),
    );
    expect(service.getWebAppUrl()).toBe('https://app.storyme.example');
  });

  it('getWebhookSecret returns the configured secret, or undefined when unset', () => {
    expect(
      new BillingConfigService(
        createConfig({ STRIPE_WEBHOOK_SECRET: 'whsec_test' }),
      ).getWebhookSecret(),
    ).toBe('whsec_test');
    expect(new BillingConfigService(createConfig({})).getWebhookSecret()).toBeUndefined();
  });
});
