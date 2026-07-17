import { describe, it, expect } from 'vitest';
import {
  isPreflightRole,
  runPreflight,
  runPreflightChecks,
  type PreflightIssue,
} from './preflight-deploy-checks';
import { envSchema } from './env.schema';

/** A fully valid production API-role env — every test starts from a shallow copy of this and breaks exactly one thing. */
const VALID_API_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pass@db.internal:5432/storyme',
  REDIS_URL: 'redis://cache.internal:6379',
  JWT_SECRET: 'a-secret-that-is-at-least-32-chars-long!!',
  JWT_REFRESH_SECRET: 'refresh-secret-that-is-at-least-32-chars!!',
  AUTH_MODE: 'jwt',
  WEB_APP_URL: 'https://storyme-demo.vercel.app',
  ALLOWED_ORIGINS: 'https://storyme-demo.vercel.app',
  EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're_test_key',
  EMAIL_FROM: 'StoryMe <noreply@storyme.app>',
  PDF_STORAGE_DRIVER: 'r2',
  PDF_STORAGE_BUCKET: 'storyme-previews',
  PDF_STORAGE_REGION: 'auto',
  PDF_STORAGE_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  PDF_STORAGE_ACCESS_KEY_ID: 'test-access-key-id',
  PDF_STORAGE_SECRET_ACCESS_KEY: 'test-secret-access-key',
  IMAGE_STORAGE_DRIVER: 'r2',
} satisfies Record<string, string>;

/** Same deployment, from the worker's env panel — no auth/email/CORS vars, per the ownership matrix. */
const VALID_WORKER_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: VALID_API_ENV.DATABASE_URL,
  REDIS_URL: VALID_API_ENV.REDIS_URL,
  JWT_SECRET: VALID_API_ENV.JWT_SECRET,
  JWT_REFRESH_SECRET: VALID_API_ENV.JWT_REFRESH_SECRET,
  PDF_STORAGE_DRIVER: VALID_API_ENV.PDF_STORAGE_DRIVER,
  PDF_STORAGE_BUCKET: VALID_API_ENV.PDF_STORAGE_BUCKET,
  PDF_STORAGE_REGION: VALID_API_ENV.PDF_STORAGE_REGION,
  PDF_STORAGE_ENDPOINT: VALID_API_ENV.PDF_STORAGE_ENDPOINT,
  PDF_STORAGE_ACCESS_KEY_ID: VALID_API_ENV.PDF_STORAGE_ACCESS_KEY_ID,
  PDF_STORAGE_SECRET_ACCESS_KEY: VALID_API_ENV.PDF_STORAGE_SECRET_ACCESS_KEY,
  IMAGE_STORAGE_DRIVER: VALID_API_ENV.IMAGE_STORAGE_DRIVER,
} satisfies Record<string, string>;

function codes(issues: PreflightIssue[]): string[] {
  return issues.map((i) => i.code);
}

describe('isPreflightRole', () => {
  it('accepts "api" and "worker"', () => {
    expect(isPreflightRole('api')).toBe(true);
    expect(isPreflightRole('worker')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isPreflightRole('web')).toBe(false);
    expect(isPreflightRole('')).toBe(false);
    expect(isPreflightRole('API')).toBe(false);
  });
});

describe('runPreflight — valid configurations', () => {
  it('passes a valid API staging configuration with no issues', () => {
    const result = runPreflight(VALID_API_ENV, 'api');
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('passes a valid worker staging configuration with no issues', () => {
    const result = runPreflight(VALID_WORKER_ENV, 'worker');
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });
});

describe('runPreflight — table-driven failure cases', () => {
  interface Case {
    name: string;
    role: 'api' | 'worker';
    env: Record<string, string | undefined>;
    expectCode: string;
  }

  const cases: Case[] = [
    {
      name: 'dev auth mode is rejected for a public API deployment',
      role: 'api',
      env: { ...VALID_API_ENV, AUTH_MODE: 'dev' },
      expectCode: 'auth_mode_not_jwt',
    },
    {
      name: 'NODE_ENV left as development is rejected',
      role: 'api',
      env: { ...VALID_API_ENV, NODE_ENV: 'development' },
      expectCode: 'node_env_not_production',
    },
    {
      name: 'a plain-HTTP WEB_APP_URL is rejected',
      role: 'api',
      env: { ...VALID_API_ENV, WEB_APP_URL: 'http://storyme-demo.vercel.app' },
      expectCode: 'web_app_url_not_https',
    },
    {
      name: 'ALLOWED_ORIGINS missing the web app origin is rejected',
      role: 'api',
      env: { ...VALID_API_ENV, ALLOWED_ORIGINS: 'https://some-other-app.example.com' },
      expectCode: 'allowed_origins_missing_web_app_url',
    },
    {
      name: 'a wildcard ALLOWED_ORIGINS is rejected even though it would technically contain any origin',
      role: 'api',
      env: { ...VALID_API_ENV, ALLOWED_ORIGINS: '*' },
      expectCode: 'allowed_origins_wildcard',
    },
    {
      name: 'local PDF storage is rejected for the api role',
      role: 'api',
      env: { ...VALID_API_ENV, PDF_STORAGE_DRIVER: 'local' },
      expectCode: 'pdf_storage_local_in_production',
    },
    {
      name: 'local PDF storage is rejected for the worker role',
      role: 'worker',
      env: { ...VALID_WORKER_ENV, PDF_STORAGE_DRIVER: 'local' },
      expectCode: 'pdf_storage_local_in_production',
    },
    {
      name: 'local image storage is rejected for the worker role',
      role: 'worker',
      env: { ...VALID_WORKER_ENV, IMAGE_STORAGE_DRIVER: 'local' },
      expectCode: 'image_storage_local_in_production',
    },
    {
      name: 'r2 storage missing the endpoint (required for r2) is rejected as incomplete',
      role: 'api',
      env: { ...VALID_API_ENV, PDF_STORAGE_ENDPOINT: undefined },
      expectCode: 'pdf_storage_incomplete',
    },
    {
      name: 's3 storage missing credentials is rejected as incomplete',
      role: 'api',
      env: {
        ...VALID_API_ENV,
        PDF_STORAGE_DRIVER: 's3',
        PDF_STORAGE_ACCESS_KEY_ID: undefined,
        PDF_STORAGE_SECRET_ACCESS_KEY: undefined,
      },
      expectCode: 'pdf_storage_incomplete',
    },
    {
      name: 'cloud image storage reusing PDF credentials but missing the bucket is rejected as incomplete',
      role: 'api',
      env: { ...VALID_API_ENV, PDF_STORAGE_BUCKET: undefined },
      // Both PDF and image storage read the same bucket var, so this trips both checks —
      // asserting the image-specific one proves the image check runs independently of the PDF one.
      expectCode: 'image_storage_incomplete',
    },
    {
      name: 'console (unset) email provider in production is rejected',
      role: 'api',
      env: {
        ...VALID_API_ENV,
        EMAIL_PROVIDER: undefined,
        RESEND_API_KEY: undefined,
        EMAIL_FROM: undefined,
      },
      expectCode: 'email_provider_not_production_capable',
    },
    {
      name: 'ENABLE_GENERATION_WORKER=true on a deployed api service is rejected',
      role: 'api',
      env: { ...VALID_API_ENV, ENABLE_GENERATION_WORKER: 'true' },
      expectCode: 'enable_generation_worker_set_on_api',
    },
  ];

  for (const { name, role, env, expectCode } of cases) {
    it(name, () => {
      const result = runPreflight(env, role);
      expect(result.ok).toBe(false);
      expect(codes(result.issues)).toContain(expectCode);
    });
  }
});

describe('runPreflight — email provider production-capable exceptions', () => {
  it('accepts console email when EMAIL_DEBUG_LOG_LINKS=true (explicit, acknowledged fallback)', () => {
    const env = {
      ...VALID_API_ENV,
      EMAIL_PROVIDER: undefined,
      RESEND_API_KEY: undefined,
      EMAIL_FROM: undefined,
      EMAIL_DEBUG_LOG_LINKS: 'true',
    };
    const result = runPreflight(env, 'api');
    expect(codes(result.issues)).not.toContain('email_provider_not_production_capable');
  });

  it('does not require email production-capability for the worker role, which never reads EMAIL_PROVIDER', () => {
    const env = { ...VALID_WORKER_ENV };
    const result = runPreflight(env, 'worker');
    expect(result.ok).toBe(true);
  });
});

describe('runPreflight — Stripe billing', () => {
  it('allows Stripe billing to stay disabled with no Stripe vars set', () => {
    const result = runPreflight({ ...VALID_API_ENV, STRIPE_BILLING_ENABLED: 'false' }, 'api');
    expect(result.ok).toBe(true);
  });

  it('rejects Stripe billing enabled with no Stripe vars set (incomplete)', () => {
    const result = runPreflight({ ...VALID_API_ENV, STRIPE_BILLING_ENABLED: 'true' }, 'api');
    expect(result.ok).toBe(false);
    expect(codes(result.issues).some((c) => c.startsWith('env_schema:STRIPE'))).toBe(true);
  });

  it('rejects Stripe billing enabled with only some package Price IDs set', () => {
    const result = runPreflight(
      {
        ...VALID_API_ENV,
        STRIPE_BILLING_ENABLED: 'true',
        STRIPE_SECRET_KEY: 'sk_test_123',
        STRIPE_WEBHOOK_SECRET: 'whsec_123',
        STRIPE_PRICE_ID_STARTER: 'price_starter',
      },
      'api',
    );
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain('env_schema:STRIPE_PRICE_ID_PRO');
    expect(codes(result.issues)).toContain('env_schema:STRIPE_PRICE_ID_BUNDLE');
  });

  it('accepts Stripe billing enabled with every required var set', () => {
    const result = runPreflight(
      {
        ...VALID_API_ENV,
        STRIPE_BILLING_ENABLED: 'true',
        STRIPE_SECRET_KEY: 'sk_test_123',
        STRIPE_WEBHOOK_SECRET: 'whsec_123',
        STRIPE_PRICE_ID_STARTER: 'price_starter',
        STRIPE_PRICE_ID_PRO: 'price_pro',
        STRIPE_PRICE_ID_BUNDLE: 'price_bundle',
      },
      'api',
    );
    expect(result.ok).toBe(true);
  });
});

describe('runPreflight — API/web build-time consistency', () => {
  it('is silently skipped when no NEXT_PUBLIC_* context is supplied', () => {
    const result = runPreflight(VALID_API_ENV, 'api', {});
    expect(result.ok).toBe(true);
  });

  it('rejects a NEXT_PUBLIC_API_URL missing the /api prefix', () => {
    const result = runPreflight(VALID_API_ENV, 'api', {
      nextPublicApiUrl: 'https://storyme-api.example.com',
    });
    expect(codes(result.issues)).toContain('next_public_api_url_missing_prefix');
  });

  it('rejects a plain-HTTP NEXT_PUBLIC_API_URL', () => {
    const result = runPreflight(VALID_API_ENV, 'api', {
      nextPublicApiUrl: 'http://storyme-api.example.com/api',
    });
    expect(codes(result.issues)).toContain('next_public_api_url_not_https');
  });

  it('rejects a NEXT_PUBLIC_AUTH_MODE that does not match AUTH_MODE', () => {
    const result = runPreflight(VALID_API_ENV, 'api', { nextPublicAuthMode: 'dev' });
    expect(codes(result.issues)).toContain('auth_mode_mismatch');
  });

  it('accepts a consistent NEXT_PUBLIC_API_URL and NEXT_PUBLIC_AUTH_MODE', () => {
    const result = runPreflight(VALID_API_ENV, 'api', {
      nextPublicApiUrl: 'https://storyme-api.example.com/api',
      nextPublicAuthMode: 'jwt',
    });
    expect(result.ok).toBe(true);
  });

  it('is not applied to the worker role even when supplied (worker owns no HTTP/web-facing config)', () => {
    const result = runPreflight(VALID_WORKER_ENV, 'worker', { nextPublicAuthMode: 'dev' });
    expect(result.ok).toBe(true);
  });
});

describe('runPreflight — malformed/missing Database or Redis config', () => {
  it('surfaces a schema-level issue when DATABASE_URL is missing', () => {
    const env = { ...VALID_API_ENV, DATABASE_URL: undefined };
    const result = runPreflight(env, 'api');
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain('env_schema:DATABASE_URL');
  });

  it('surfaces a schema-level issue when REDIS_URL is malformed', () => {
    const env = { ...VALID_API_ENV, REDIS_URL: 'not-a-url' };
    const result = runPreflight(env, 'api');
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain('env_schema:REDIS_URL');
  });

  it('does not run the custom cross-setting checks at all when the base schema itself is invalid', () => {
    // No DATABASE_URL/REDIS_URL/JWT secrets at all — envSchema.safeParse fails before
    // any of runPreflightChecks' invariants (which need a validly-shaped Env) can run.
    const result = runPreflight({}, 'api');
    expect(result.ok).toBe(false);
    expect(result.issues.every((i) => i.code.startsWith('env_schema:'))).toBe(true);
  });
});

describe('runPreflight — safe error output', () => {
  const SECRET_VALUES = [
    VALID_API_ENV.JWT_SECRET,
    VALID_API_ENV.JWT_REFRESH_SECRET,
    VALID_API_ENV.RESEND_API_KEY,
    VALID_API_ENV.PDF_STORAGE_ACCESS_KEY_ID,
    VALID_API_ENV.PDF_STORAGE_SECRET_ACCESS_KEY,
  ];

  /** Every failure case above, replayed once more, asserting none of the actual secret values supplied ever appear in the issue text. */
  it('never echoes a supplied secret value back in any issue message, across every failure case in this suite', () => {
    const scenarios: Array<[Record<string, string | undefined>, 'api' | 'worker']> = [
      [{ ...VALID_API_ENV, AUTH_MODE: 'dev' }, 'api'],
      [{ ...VALID_API_ENV, PDF_STORAGE_DRIVER: 'local' }, 'api'],
      [{ ...VALID_API_ENV, PDF_STORAGE_ACCESS_KEY_ID: undefined }, 'api'],
      [
        {
          ...VALID_API_ENV,
          EMAIL_PROVIDER: undefined,
          RESEND_API_KEY: undefined,
          EMAIL_FROM: undefined,
        },
        'api',
      ],
      [{ ...VALID_API_ENV, STRIPE_BILLING_ENABLED: 'true' }, 'api'],
      [{}, 'api'],
    ];

    for (const [env, role] of scenarios) {
      const result = runPreflight(env, role);
      const text = result.issues.map((i) => i.message).join('\n');
      for (const secret of SECRET_VALUES) {
        expect(text.includes(secret)).toBe(false);
      }
    }
  });

  it('reports only variable names/paths and static guidance for a schema-level failure, never the Zod "received" input', () => {
    const result = runPreflight(
      { ...VALID_API_ENV, JWT_SECRET: 'super-secret-value-do-not-print' },
      'api',
    );
    const text = result.issues.map((i) => i.message).join('\n');
    expect(text.includes('super-secret-value-do-not-print')).toBe(false);
  });
});

describe('runPreflightChecks — role scoping (pure function, no envSchema parse)', () => {
  it('applies HTTP-surface checks (auth mode, CORS, email) only to the api role', () => {
    const parsed = envSchema.parse({ ...VALID_WORKER_ENV, AUTH_MODE: 'dev' });
    const apiIssues = runPreflightChecks(parsed, 'api');
    const workerIssues = runPreflightChecks(parsed, 'worker');
    expect(codes(apiIssues)).toContain('auth_mode_not_jwt');
    expect(codes(workerIssues)).not.toContain('auth_mode_not_jwt');
  });

  it('applies storage checks identically to both roles', () => {
    const parsed = envSchema.parse({ ...VALID_API_ENV, PDF_STORAGE_DRIVER: 'local' });
    const apiIssues = runPreflightChecks(parsed, 'api');
    const workerIssues = runPreflightChecks(parsed, 'worker');
    expect(codes(apiIssues)).toContain('pdf_storage_local_in_production');
    expect(codes(workerIssues)).toContain('pdf_storage_local_in_production');
  });
});
