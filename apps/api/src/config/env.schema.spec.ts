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
});
