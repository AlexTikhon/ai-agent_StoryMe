import { z } from 'zod';

/**
 * All required + optional environment variables validated at startup.
 * App refuses to start if any required var is absent or malformed.
 */
export const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),

  // Database
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid postgresql:// URL'),

  // Redis
  REDIS_URL: z.string().url('REDIS_URL must be a valid redis:// URL'),

  // Auth
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),

  // AI Providers
  // ANTHROPIC_API_KEY and FAL_API_KEY are reserved for providers not wired up
  // yet (no code path reads them) — optional so deploys aren't blocked on
  // credentials for unbuilt features. OPENAI_API_KEY is read by the real
  // story/image generation providers and is required.
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().min(1),
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
});

export type Env = z.infer<typeof envSchema>;
