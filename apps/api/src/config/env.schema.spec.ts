import { describe, it, expect } from 'vitest';
import { envSchema } from './env.schema';

describe('envSchema', () => {
  it('accepts a fully valid environment', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a-secret-that-is-at-least-32-chars-long!!',
      JWT_REFRESH_SECRET: 'refresh-secret-that-is-at-least-32-chars!!',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENAI_API_KEY: 'sk-test',
      FAL_API_KEY: 'fal-test',
      R2_ACCOUNT_ID: 'test-account',
      R2_ACCESS_KEY_ID: 'test-key',
      R2_SECRET_ACCESS_KEY: 'test-secret',
      R2_BUCKET_NAME: 'test-bucket',
    });
    expect(result.success).toBe(true);
  });

  it('rejects when DATABASE_URL is missing', () => {
    const result = envSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects a JWT_SECRET shorter than 32 characters', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'too-short',
      JWT_REFRESH_SECRET: 'also-too-short',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENAI_API_KEY: 'sk-test',
      FAL_API_KEY: 'fal-test',
      R2_ACCOUNT_ID: 'test-account',
      R2_ACCESS_KEY_ID: 'test-key',
      R2_SECRET_ACCESS_KEY: 'test-secret',
      R2_BUCKET_NAME: 'test-bucket',
    });
    expect(result.success).toBe(false);
  });

  it('applies PORT default of 4000', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a-secret-that-is-at-least-32-chars-long!!',
      JWT_REFRESH_SECRET: 'refresh-secret-that-is-at-least-32-chars!!',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENAI_API_KEY: 'sk-test',
      FAL_API_KEY: 'fal-test',
      R2_ACCOUNT_ID: 'test-account',
      R2_ACCESS_KEY_ID: 'test-key',
      R2_SECRET_ACCESS_KEY: 'test-secret',
      R2_BUCKET_NAME: 'test-bucket',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(4000);
    }
  });

  it('applies PDF_STORAGE_DRIVER default of local', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a-secret-that-is-at-least-32-chars-long!!',
      JWT_REFRESH_SECRET: 'refresh-secret-that-is-at-least-32-chars!!',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENAI_API_KEY: 'sk-test',
      FAL_API_KEY: 'fal-test',
      R2_ACCOUNT_ID: 'test-account',
      R2_ACCESS_KEY_ID: 'test-key',
      R2_SECRET_ACCESS_KEY: 'test-secret',
      R2_BUCKET_NAME: 'test-bucket',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PDF_STORAGE_DRIVER).toBe('local');
    }
  });

  it('accepts PDF_STORAGE_DRIVER s3 and r2', () => {
    const base = {
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a-secret-that-is-at-least-32-chars-long!!',
      JWT_REFRESH_SECRET: 'refresh-secret-that-is-at-least-32-chars!!',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENAI_API_KEY: 'sk-test',
      FAL_API_KEY: 'fal-test',
      R2_ACCOUNT_ID: 'test-account',
      R2_ACCESS_KEY_ID: 'test-key',
      R2_SECRET_ACCESS_KEY: 'test-secret',
      R2_BUCKET_NAME: 'test-bucket',
    };
    expect(envSchema.safeParse({ ...base, PDF_STORAGE_DRIVER: 's3' }).success).toBe(true);
    expect(envSchema.safeParse({ ...base, PDF_STORAGE_DRIVER: 'r2' }).success).toBe(true);
  });

  it('rejects an unknown PDF_STORAGE_DRIVER value', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a-secret-that-is-at-least-32-chars-long!!',
      JWT_REFRESH_SECRET: 'refresh-secret-that-is-at-least-32-chars!!',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENAI_API_KEY: 'sk-test',
      FAL_API_KEY: 'fal-test',
      R2_ACCOUNT_ID: 'test-account',
      R2_ACCESS_KEY_ID: 'test-key',
      R2_SECRET_ACCESS_KEY: 'test-secret',
      R2_BUCKET_NAME: 'test-bucket',
      PDF_STORAGE_DRIVER: 'gcs',
    });
    expect(result.success).toBe(false);
  });

  it('applies IMAGE_STORAGE_DRIVER default of local', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a-secret-that-is-at-least-32-chars-long!!',
      JWT_REFRESH_SECRET: 'refresh-secret-that-is-at-least-32-chars!!',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENAI_API_KEY: 'sk-test',
      FAL_API_KEY: 'fal-test',
      R2_ACCOUNT_ID: 'test-account',
      R2_ACCESS_KEY_ID: 'test-key',
      R2_SECRET_ACCESS_KEY: 'test-secret',
      R2_BUCKET_NAME: 'test-bucket',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.IMAGE_STORAGE_DRIVER).toBe('local');
    }
  });

  it('accepts IMAGE_STORAGE_DRIVER s3 and r2', () => {
    const base = {
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a-secret-that-is-at-least-32-chars-long!!',
      JWT_REFRESH_SECRET: 'refresh-secret-that-is-at-least-32-chars!!',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENAI_API_KEY: 'sk-test',
      FAL_API_KEY: 'fal-test',
      R2_ACCOUNT_ID: 'test-account',
      R2_ACCESS_KEY_ID: 'test-key',
      R2_SECRET_ACCESS_KEY: 'test-secret',
      R2_BUCKET_NAME: 'test-bucket',
    };
    expect(envSchema.safeParse({ ...base, IMAGE_STORAGE_DRIVER: 's3' }).success).toBe(true);
    expect(envSchema.safeParse({ ...base, IMAGE_STORAGE_DRIVER: 'r2' }).success).toBe(true);
  });

  it('rejects an unknown IMAGE_STORAGE_DRIVER value', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a-secret-that-is-at-least-32-chars-long!!',
      JWT_REFRESH_SECRET: 'refresh-secret-that-is-at-least-32-chars!!',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENAI_API_KEY: 'sk-test',
      FAL_API_KEY: 'fal-test',
      R2_ACCOUNT_ID: 'test-account',
      R2_ACCESS_KEY_ID: 'test-key',
      R2_SECRET_ACCESS_KEY: 'test-secret',
      R2_BUCKET_NAME: 'test-bucket',
      IMAGE_STORAGE_DRIVER: 'gcs',
    });
    expect(result.success).toBe(false);
  });

  it('defaults AUTH_MODE to jwt when unset (safe default outside dev)', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a-secret-that-is-at-least-32-chars-long!!',
      JWT_REFRESH_SECRET: 'refresh-secret-that-is-at-least-32-chars!!',
      OPENAI_API_KEY: 'sk-test',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.AUTH_MODE).toBe('jwt');
    }
  });

  it('accepts an explicit AUTH_MODE of dev', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a-secret-that-is-at-least-32-chars-long!!',
      JWT_REFRESH_SECRET: 'refresh-secret-that-is-at-least-32-chars!!',
      OPENAI_API_KEY: 'sk-test',
      AUTH_MODE: 'dev',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.AUTH_MODE).toBe('dev');
    }
  });

  it('rejects an unknown AUTH_MODE value', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a-secret-that-is-at-least-32-chars-long!!',
      JWT_REFRESH_SECRET: 'refresh-secret-that-is-at-least-32-chars!!',
      OPENAI_API_KEY: 'sk-test',
      AUTH_MODE: 'basic',
    });
    expect(result.success).toBe(false);
  });

  describe('OPENAI_API_KEY conditional requirement', () => {
    const REQUIRED = {
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a-secret-that-is-at-least-32-chars-long!!',
      JWT_REFRESH_SECRET: 'refresh-secret-that-is-at-least-32-chars!!',
    };

    it('boots with no OPENAI_API_KEY when both providers are unset (default mock)', () => {
      const result = envSchema.safeParse({ ...REQUIRED });
      expect(result.success).toBe(true);
    });

    it('boots with no OPENAI_API_KEY when both providers are explicitly "mock"', () => {
      const result = envSchema.safeParse({
        ...REQUIRED,
        STORY_GENERATION_PROVIDER: 'mock',
        IMAGE_GENERATION_PROVIDER: 'mock',
      });
      expect(result.success).toBe(true);
    });

    it('rejects when STORY_GENERATION_PROVIDER=openai and OPENAI_API_KEY is missing', () => {
      const result = envSchema.safeParse({
        ...REQUIRED,
        STORY_GENERATION_PROVIDER: 'openai',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors.some((e) => e.path.join('.') === 'OPENAI_API_KEY')).toBe(true);
      }
    });

    it('rejects when IMAGE_GENERATION_PROVIDER=openai and OPENAI_API_KEY is missing', () => {
      const result = envSchema.safeParse({
        ...REQUIRED,
        IMAGE_GENERATION_PROVIDER: 'openai',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors.some((e) => e.path.join('.') === 'OPENAI_API_KEY')).toBe(true);
      }
    });

    it('rejects case-insensitively (e.g. "OpenAI") to match the provider factories', () => {
      const result = envSchema.safeParse({
        ...REQUIRED,
        STORY_GENERATION_PROVIDER: 'OpenAI',
      });
      expect(result.success).toBe(false);
    });

    it('accepts STORY_GENERATION_PROVIDER=openai when OPENAI_API_KEY is set', () => {
      const result = envSchema.safeParse({
        ...REQUIRED,
        STORY_GENERATION_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-test',
      });
      expect(result.success).toBe(true);
    });

    it('accepts IMAGE_GENERATION_PROVIDER=openai when OPENAI_API_KEY is set', () => {
      const result = envSchema.safeParse({
        ...REQUIRED,
        IMAGE_GENERATION_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-test',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('EMAIL_PROVIDER conditional requirement', () => {
    const REQUIRED = {
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a-secret-that-is-at-least-32-chars-long!!',
      JWT_REFRESH_SECRET: 'refresh-secret-that-is-at-least-32-chars!!',
    };

    it('boots with no RESEND_API_KEY/EMAIL_FROM when EMAIL_PROVIDER is unset (default console)', () => {
      const result = envSchema.safeParse({ ...REQUIRED });
      expect(result.success).toBe(true);
    });

    it('boots with no RESEND_API_KEY/EMAIL_FROM when EMAIL_PROVIDER is explicitly "console"', () => {
      const result = envSchema.safeParse({ ...REQUIRED, EMAIL_PROVIDER: 'console' });
      expect(result.success).toBe(true);
    });

    it('rejects when EMAIL_PROVIDER=resend and both RESEND_API_KEY and EMAIL_FROM are missing', () => {
      const result = envSchema.safeParse({ ...REQUIRED, EMAIL_PROVIDER: 'resend' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.errors.map((e) => e.path.join('.'));
        expect(paths).toContain('RESEND_API_KEY');
        expect(paths).toContain('EMAIL_FROM');
      }
    });

    it('rejects when EMAIL_PROVIDER=resend and only EMAIL_FROM is set', () => {
      const result = envSchema.safeParse({
        ...REQUIRED,
        EMAIL_PROVIDER: 'resend',
        EMAIL_FROM: 'StoryMe <noreply@storyme.app>',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors.some((e) => e.path.join('.') === 'RESEND_API_KEY')).toBe(true);
      }
    });

    it('accepts EMAIL_PROVIDER=resend when RESEND_API_KEY and EMAIL_FROM are both set', () => {
      const result = envSchema.safeParse({
        ...REQUIRED,
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_test_key',
        EMAIL_FROM: 'StoryMe <noreply@storyme.app>',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('STRIPE_BILLING_ENABLED conditional requirement', () => {
    const REQUIRED = {
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a-secret-that-is-at-least-32-chars-long!!',
      JWT_REFRESH_SECRET: 'refresh-secret-that-is-at-least-32-chars!!',
    };
    const STRIPE_VARS = {
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_123',
      STRIPE_PRICE_ID_STARTER: 'price_starter',
      STRIPE_PRICE_ID_PRO: 'price_pro',
      STRIPE_PRICE_ID_BUNDLE: 'price_bundle',
    };

    it('defaults to disabled and boots with no Stripe vars at all', () => {
      const result = envSchema.safeParse({ ...REQUIRED });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.STRIPE_BILLING_ENABLED).toBe('false');
      }
    });

    it('boots with no Stripe vars when STRIPE_BILLING_ENABLED is explicitly "false"', () => {
      const result = envSchema.safeParse({ ...REQUIRED, STRIPE_BILLING_ENABLED: 'false' });
      expect(result.success).toBe(true);
    });

    it('rejects STRIPE_BILLING_ENABLED=true with no Stripe vars set, naming every missing one', () => {
      const result = envSchema.safeParse({ ...REQUIRED, STRIPE_BILLING_ENABLED: 'true' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.errors.map((e) => e.path.join('.'));
        expect(paths).toContain('STRIPE_SECRET_KEY');
        expect(paths).toContain('STRIPE_WEBHOOK_SECRET');
        expect(paths).toContain('STRIPE_PRICE_ID_STARTER');
        expect(paths).toContain('STRIPE_PRICE_ID_PRO');
        expect(paths).toContain('STRIPE_PRICE_ID_BUNDLE');
      }
    });

    it('rejects STRIPE_BILLING_ENABLED=true when only some package Price IDs are set (partial config)', () => {
      const result = envSchema.safeParse({
        ...REQUIRED,
        STRIPE_BILLING_ENABLED: 'true',
        STRIPE_SECRET_KEY: 'sk_test_123',
        STRIPE_WEBHOOK_SECRET: 'whsec_123',
        STRIPE_PRICE_ID_STARTER: 'price_starter',
        // STRIPE_PRICE_ID_PRO and STRIPE_PRICE_ID_BUNDLE deliberately missing
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.errors.map((e) => e.path.join('.'));
        expect(paths).toContain('STRIPE_PRICE_ID_PRO');
        expect(paths).toContain('STRIPE_PRICE_ID_BUNDLE');
        expect(paths).not.toContain('STRIPE_SECRET_KEY');
      }
    });

    it('accepts STRIPE_BILLING_ENABLED=true when every required Stripe var is set', () => {
      const result = envSchema.safeParse({
        ...REQUIRED,
        STRIPE_BILLING_ENABLED: 'true',
        ...STRIPE_VARS,
      });
      expect(result.success).toBe(true);
    });

    it('rejects an unknown STRIPE_BILLING_ENABLED value', () => {
      const result = envSchema.safeParse({ ...REQUIRED, STRIPE_BILLING_ENABLED: 'yes' });
      expect(result.success).toBe(false);
    });
  });
});
