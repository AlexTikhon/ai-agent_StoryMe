import { z } from 'zod';

/**
 * All required + optional environment variables validated at startup.
 * App refuses to start if any required var is absent or malformed.
 */
export const envSchema = z
  .object({
    // Server
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),

    // Process topology — read directly from process.env in main.ts/worker.ts
    // (before ConfigService exists) to decide whether GenerationQueueProcessor
    // is registered at all; also declared here so a malformed value still
    // fails loudly at boot instead of silently being treated as "false".
    // main.ts never sets this (API never self-enables); worker.ts always
    // passes `true` regardless of this var. See apps/api/docs/local-generation-pipeline.md
    // ("Worker process separation").
    ENABLE_GENERATION_WORKER: z.enum(['true', 'false']).default('false'),

    // Web app origin, used only to build links sent in transactional emails
    // (e.g. the email verification link: `${WEB_APP_URL}/verify-email?token=...`).
    // Defaults to the local web dev server.
    WEB_APP_URL: z.string().url().default('http://localhost:3000'),

    // Database
    DATABASE_URL: z.string().url('DATABASE_URL must be a valid postgresql:// URL'),

    // Redis
    REDIS_URL: z.string().url('REDIS_URL must be a valid redis:// URL'),

    // Auth
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    // dev: DevAuthGuard (x-user-email header, no credential check) — refuses to
    // run when NODE_ENV=production regardless of this setting.
    // jwt: real email/password + JWT access token + rotating refresh cookie.
    // Defaults to jwt so an environment that forgets to set this is safe.
    AUTH_MODE: z.enum(['dev', 'jwt']).default('jwt'),

    // Rate limiting on /api/auth/* (register, login, refresh, logout) — see
    // apps/api/src/rate-limit/. Redis-backed (RATE_LIMITER_TOKEN resolves to
    // RedisRateLimiter), correct across every API instance; sane defaults
    // that shouldn't interfere with normal local dev/demo usage.
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
    // Per-route+IP+email budget — tight, since a legitimate user rarely
    // retries the same credential this many times.
    AUTH_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
    // Per-route+IP budget — deliberately looser than the per-email budget so
    // many legitimate users sharing one IP (office network, NAT, campus wifi)
    // aren't crushed by a single tight threshold, while still capping how
    // many attempts one IP can make in total regardless of which email it
    // targets (see AuthRateLimitGuard's own doc comment).
    AUTH_RATE_LIMIT_IP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(30),

    // Per-user rate limiting on expensive BooksController actions — Redis-backed
    // (see rate-limit/redis-rate-limiter.service.ts), correct across every
    // API instance. Generation covers POST /:id/generate and
    // /:id/retry-generation (both start a paid pipeline run); child-photo
    // covers the upload endpoint; diagnostics covers the polling endpoint the
    // web app calls on an interval.
    GENERATION_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(3_600_000),
    GENERATION_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
    CHILD_PHOTO_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(3_600_000),
    CHILD_PHOTO_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(20),
    DIAGNOSTICS_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    DIAGNOSTICS_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(60),
    // Phase G1: POST /:id/cancel — a user reacting to an in-progress
    // generation they want to stop, so this budget is looser than
    // GENERATION_RATE_LIMIT above (which gates starting a new *paid* run);
    // cancelling is free and a user may legitimately retry the request if an
    // earlier attempt raced a concurrent completion/cancellation.
    CANCEL_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(3_600_000),
    CANCEL_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(30),

    // Business-rule generation caps (distinct from the raw per-route request
    // throttle above) — how many actual paid generation runs one user may
    // have in flight or start in a rolling window. Enforced in
    // BooksService.assertGenerationAllowed.
    MAX_CONCURRENT_GENERATIONS_PER_USER: z.coerce.number().int().positive().default(2),
    GENERATION_USER_WINDOW_MS: z.coerce.number().int().positive().default(86_400_000),
    MAX_GENERATIONS_PER_USER_PER_WINDOW: z.coerce.number().int().positive().default(20),

    // Global circuit breaker on total generation starts across all users —
    // a safety valve against a runaway cost incident (bug, abuse, provider
    // pricing change), not a per-user quota. Generous defaults so it never
    // interferes with normal traffic; tune down during an incident.
    GLOBAL_GENERATION_CIRCUIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    GLOBAL_GENERATION_CIRCUIT_MAX_PER_WINDOW: z.coerce.number().int().positive().default(100),

    // Story/image generation provider selection (STORY_GENERATION_PROVIDER /
    // IMAGE_GENERATION_PROVIDER). Kept as loose optional strings (not a
    // z.enum) so this schema can't diverge from the case-insensitive parsing
    // in story-generation-provider.factory.ts /
    // image-generation-provider.factory.ts — those factories still own
    // validating the value itself (they throw "Unknown ..." for anything
    // other than "mock"/"openai") and run during Nest module init, so an
    // invalid value is still caught at boot, just one layer down from here.
    STORY_GENERATION_PROVIDER: z.string().optional(),
    IMAGE_GENERATION_PROVIDER: z.string().optional(),

    // Transactional email provider selection. Loose optional string (not a
    // z.enum) for the same reason as STORY_GENERATION_PROVIDER above — the
    // factory (email-provider.factory.ts) owns validating the value itself
    // and runs at Nest module init, so an invalid value is still caught at
    // boot, just one layer down. Defaults to "console" (ConsoleEmailService,
    // no real email sent) so local dev/test/CI never depend on Resend
    // credentials unless EMAIL_PROVIDER=resend is explicitly set.
    EMAIL_PROVIDER: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),
    // "from" address for outbound email, e.g. "StoryMe <noreply@storyme.app>".
    // Only required when EMAIL_PROVIDER=resend — see the superRefine below.
    EMAIL_FROM: z.string().optional(),
    EMAIL_REPLY_TO: z.string().optional(),
    // MVP-testing fallback only — see email-provider.factory.ts. When the
    // resolved provider is "console" (no real EMAIL_PROVIDER configured) and
    // NODE_ENV=production, the factory normally suppresses the raw
    // verification/reset link from logs (it contains a live token) and logs
    // an error instead. Setting this to "true" re-enables logging the link
    // (recipient email + URL only) so a link can still be retrieved from
    // Railway logs while a real provider isn't wired up yet. Defaults to
    // false; must be turned off again once EMAIL_PROVIDER=resend is set.
    EMAIL_DEBUG_LOG_LINKS: z.enum(['true', 'false']).optional(),

    // AI Providers
    // ANTHROPIC_API_KEY and FAL_API_KEY are reserved for providers not wired up
    // yet (no code path reads them) — optional so deploys aren't blocked on
    // credentials for unbuilt features. OPENAI_API_KEY is only required when
    // STORY_GENERATION_PROVIDER or IMAGE_GENERATION_PROVIDER is set to
    // "openai" — see the superRefine below. Mock mode (the default for both)
    // must be able to boot with no OpenAI credentials at all.
    ANTHROPIC_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().min(1).optional(),
    FAL_API_KEY: z.string().optional(),

    // Storage (Cloudflare R2 / MinIO) — reserved for the future Upload feature;
    // no code path reads these yet, so they're optional until that lands.
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET_NAME: z.string().optional(),
    R2_ENDPOINT: z.string().url().optional(),
    R2_PUBLIC_URL: z.string().url().optional(),

    // PDF storage
    PDF_STORAGE_DRIVER: z.enum(['local', 's3', 'r2']).default('local'),
    PDF_STORAGE_BUCKET: z.string().optional(),
    PDF_STORAGE_REGION: z.string().optional(),
    PDF_STORAGE_ENDPOINT: z.string().url().optional(),
    PDF_STORAGE_ACCESS_KEY_ID: z.string().optional(),
    PDF_STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
    PDF_STORAGE_FORCE_PATH_STYLE: z.enum(['true', 'false']).optional(),

    // Image asset storage — driver selection only. s3/r2 reuse the same
    // PDF_STORAGE_* bucket/credential vars above (see readCloudConfig in
    // pdf-storage.ts and createImageAssetStorage in image-asset-storage.ts),
    // so PDF previews and generated images can independently opt into cloud
    // storage without a second set of credentials.
    IMAGE_STORAGE_DRIVER: z.enum(['local', 's3', 'r2']).default('local'),

    // ─── Orphaned claim-artifact cleanup (Phase C) ──────────────────────────
    // Storage-listing sweeper that deletes claim-scoped image/PDF artifacts
    // (see generation-artifact-namespace.ts) once nothing references them
    // anymore — see ClaimArtifactCleanupService for the full protection
    // predicate. Disabled and dry-run by default: an operator must
    // explicitly opt into both real scheduling AND real deletion.
    CLAIM_CLEANUP_ENABLED: z.enum(['true', 'false']).default('false'),
    CLAIM_CLEANUP_DRY_RUN: z.enum(['true', 'false']).default('true'),
    // How long (ms) a claim namespace must sit untouched (by the storage
    // driver's own reported lastModified) before it's even eligible for
    // deletion, regardless of any DB pointer. Must comfortably exceed every
    // generation-side lease this project uses (RECOVERY_LEASE_MS,
    // GenerationRun's own per-attempt lease) — otherwise a namespace an
    // in-flight run is still writing to, but which no Book pointer has been
    // updated to reference yet, could look "old enough" and get deleted out
    // from under that run. Defaults to 24h, generously above every lease
    // default in this project (all measured in minutes).
    CLAIM_CLEANUP_RETENTION_MS: z.coerce.number().int().positive().default(86_400_000),
    // How often (ms) a new sweep pass starts. Defaults to 30 minutes.
    CLAIM_CLEANUP_INTERVAL_MS: z.coerce.number().int().positive().default(1_800_000),
    // Dedicated RecoveryLease row TTL (ms) this service's leader election
    // uses — see the "claim_artifact_cleanup" lease id, distinct from
    // GenerationRunRecoveryService's "generation_run_recovery" lease so the
    // two sweeps never contend for the same row. Defaults to 10 minutes.
    CLAIM_CLEANUP_LEASE_MS: z.coerce.number().int().positive().default(600_000),
    // Requested page size per storage list call — every driver additionally
    // clamps this to its own provider limit (S3/R2: 1000 keys per
    // ListObjectsV2 call).
    CLAIM_CLEANUP_PAGE_SIZE: z.coerce.number().int().positive().default(500),
    // Safety caps bounding a single pass's work: total raw objects listed
    // across both storage drivers, and total namespaces classified/deleted,
    // before the pass stops early and leaves the remainder for the next
    // scheduled pass.
    CLAIM_CLEANUP_MAX_OBJECTS_PER_PASS: z.coerce.number().int().positive().default(10_000),
    CLAIM_CLEANUP_MAX_NAMESPACES_PER_PASS: z.coerce.number().int().positive().default(200),
    // How many deleteClaimArtifacts calls for one namespace may be in
    // flight at once (bounded parallelism, not a raw throughput target).
    CLAIM_CLEANUP_DELETE_CONCURRENCY: z.coerce.number().int().positive().default(5),

    // ─── Stripe billing (Phase E3) ──────────────────────────────────────────
    // Safe-by-default kill switch: "false" (default) means POST
    // /api/billing/checkout fails closed with a stable BILLING_DISABLED error
    // and never constructs a Stripe client or makes a network call. Only
    // flipping this to "true" turns on the superRefine block below, which
    // then requires every other Stripe var (including all three package
    // Price IDs) to be present — a partially configured enabled deployment
    // fails at startup, not at first checkout request. WEB_APP_URL is
    // deliberately not re-checked here: it is already a required, validated
    // (z.string().url()), always-defaulted field above, so it can never be
    // absent regardless of this flag.
    STRIPE_BILLING_ENABLED: z.enum(['true', 'false']).default('false'),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    // Server-owned credit package catalog (apps/api/src/billing/billing-packages.ts)
    // — maps each stable public package id to a real Stripe Price ID. Never
    // read from the client; a request only ever supplies the public id.
    STRIPE_PRICE_ID_STARTER: z.string().optional(),
    STRIPE_PRICE_ID_PRO: z.string().optional(),
    STRIPE_PRICE_ID_BUNDLE: z.string().optional(),

    // Redis-backed per-user rate limit on POST /api/billing/checkout — same
    // mechanism as GENERATION_RATE_LIMIT_* above. Tight budget: legitimate
    // checkout retries are rare, and each call creates a real Stripe Checkout
    // Session.
    BILLING_CHECKOUT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(3_600_000),
    BILLING_CHECKOUT_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),

    // Redis-backed per-user rate limit on GET
    // /api/billing/checkout/:sessionId/status — a bounded-polling read (Phase
    // E4's /billing/success page), so the budget is much higher than the
    // checkout-creation limit above: it's a local DB read that never calls
    // Stripe, not a real Checkout Session creation.
    BILLING_CHECKOUT_STATUS_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000),
    BILLING_CHECKOUT_STATUS_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(30),

    // OAuth (optional)
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CALLBACK_URL: z.string().url().optional(),
  })
  .superRefine((env, ctx) => {
    const isOpenAI = (value: string | undefined) => value?.trim().toLowerCase() === 'openai';
    if (
      !env.OPENAI_API_KEY &&
      (isOpenAI(env.STORY_GENERATION_PROVIDER) || isOpenAI(env.IMAGE_GENERATION_PROVIDER))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'OPENAI_API_KEY is required when STORY_GENERATION_PROVIDER=openai or IMAGE_GENERATION_PROVIDER=openai',
        path: ['OPENAI_API_KEY'],
      });
    }

    if (env.EMAIL_PROVIDER?.trim().toLowerCase() === 'resend') {
      if (!env.RESEND_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'RESEND_API_KEY is required when EMAIL_PROVIDER=resend',
          path: ['RESEND_API_KEY'],
        });
      }
      if (!env.EMAIL_FROM) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'EMAIL_FROM is required when EMAIL_PROVIDER=resend',
          path: ['EMAIL_FROM'],
        });
      }
    }

    if (env.STRIPE_BILLING_ENABLED === 'true') {
      const required: Array<[keyof Env, string]> = [
        ['STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY'],
        ['STRIPE_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_SECRET'],
        ['STRIPE_PRICE_ID_STARTER', 'STRIPE_PRICE_ID_STARTER'],
        ['STRIPE_PRICE_ID_PRO', 'STRIPE_PRICE_ID_PRO'],
        ['STRIPE_PRICE_ID_BUNDLE', 'STRIPE_PRICE_ID_BUNDLE'],
      ];
      for (const [key, label] of required) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${label} is required when STRIPE_BILLING_ENABLED=true`,
            path: [key],
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;
