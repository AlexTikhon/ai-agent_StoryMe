import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

export const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'Idempotency-Key',
  'X-Request-ID',
  // Dev-only auth headers — remove once real auth replaces DevAuthGuard.
  'x-user-email',
  'x-user-name',
] as const;

interface CorsEnvironment {
  readonly ALLOWED_ORIGINS?: string;
}

export function buildCorsOptions(env: CorsEnvironment = process.env): CorsOptions {
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
  };
}
