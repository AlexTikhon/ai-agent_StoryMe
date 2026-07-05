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
    // apps/api/src/rate-limit/. In-memory, single-process; sane defaults that
    // shouldn't interfere with normal local dev/demo usage.
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
    AUTH_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),

    // Story/image generation provider selection. Kept as loose optional
    // strings (not a z.enum) so this schema can't diverge from the
    // case-insensitive parsing in story-generation-provider.factory.ts /
    // image-generation-provider.factory.ts — those factories still own
    // validating the value itself (they throw "Unknown ..." for anything
    // other than "mock"/"openai") and run during Nest module init, so an
    // invalid value is still caught at boot, just one layer down from here.
    STORY_GENERATION_PROVIDER: z.string().optional(),
    IMAGE_GENERATION_PROVIDER_TOKEN: z.string().optional(),

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
    // STORY_GENERATION_PROVIDER or IMAGE_GENERATION_PROVIDER_TOKEN is set to
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

    // Stripe (optional in dev)
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),

    // OAuth (optional)
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CALLBACK_URL: z.string().url().optional(),
  })
  .superRefine((env, ctx) => {
    const isOpenAI = (value: string | undefined) => value?.trim().toLowerCase() === 'openai';
    if (
      !env.OPENAI_API_KEY &&
      (isOpenAI(env.STORY_GENERATION_PROVIDER) || isOpenAI(env.IMAGE_GENERATION_PROVIDER_TOKEN))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'OPENAI_API_KEY is required when STORY_GENERATION_PROVIDER=openai or IMAGE_GENERATION_PROVIDER_TOKEN=openai',
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
  });

export type Env = z.infer<typeof envSchema>;
