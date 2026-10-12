import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * EnvModule calls ConfigModule.forRoot(...) while its decorator is evaluated,
 * and the real forRoot both reads a `.env` from the working directory and
 * returns a promise that rejects on invalid configuration. Replacing it here
 * keeps this spec independent of any developer file or ambient variable, and
 * lets it exercise the module's own validate callback directly: the exact
 * function production hands to @nestjs/config.
 */
const forRoot = vi.hoisted(() => vi.fn());
vi.mock('@nestjs/config', () => ({ ConfigModule: { forRoot } }));

type ForRootOptions = {
  isGlobal: boolean;
  cache: boolean;
  validate: (raw: Record<string, unknown>) => Record<string, unknown>;
};

const VALID_ENV = {
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

let options: ForRootOptions;

beforeAll(async () => {
  await import('./env.module');
  expect(forRoot).toHaveBeenCalledTimes(1);
  options = forRoot.mock.calls[0]![0] as ForRootOptions;
});

describe('EnvModule', () => {
  it('registers a global, cached ConfigModule with validation', () => {
    expect(options.isGlobal).toBe(true);
    expect(options.cache).toBe(true);
    expect(typeof options.validate).toBe('function');
  });

  it('rejects a missing configuration and names every missing required variable', () => {
    expect(() => options.validate({})).toThrow(/\[EnvModule\] Environment validation failed/);
    let message = '';
    try {
      options.validate({});
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET']) {
      expect(message).toContain(`  ${name}: `);
    }
  });

  it('rejects a malformed value rather than accepting it', () => {
    expect(() => options.validate({ ...VALID_ENV, JWT_SECRET: 'too-short' })).toThrow(
      /JWT_SECRET: JWT_SECRET must be at least 32 characters/,
    );
    expect(() => options.validate({ ...VALID_ENV, REDIS_URL: 'not a url' })).toThrow(/REDIS_URL/);
  });

  it('returns the parsed configuration, with defaults applied, for a valid environment', () => {
    const parsed = options.validate({ ...VALID_ENV });
    expect(parsed).toMatchObject({
      DATABASE_URL: VALID_ENV.DATABASE_URL,
      NODE_ENV: 'development',
      PORT: 4000,
    });
  });
});
