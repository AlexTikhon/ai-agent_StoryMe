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
        IMAGE_GENERATION_PROVIDER_TOKEN: 'mock',
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

    it('rejects when IMAGE_GENERATION_PROVIDER_TOKEN=openai and OPENAI_API_KEY is missing', () => {
      const result = envSchema.safeParse({
        ...REQUIRED,
        IMAGE_GENERATION_PROVIDER_TOKEN: 'openai',
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

    it('accepts IMAGE_GENERATION_PROVIDER_TOKEN=openai when OPENAI_API_KEY is set', () => {
      const result = envSchema.safeParse({
        ...REQUIRED,
        IMAGE_GENERATION_PROVIDER_TOKEN: 'openai',
        OPENAI_API_KEY: 'sk-test',
      });
      expect(result.success).toBe(true);
    });
  });
});
