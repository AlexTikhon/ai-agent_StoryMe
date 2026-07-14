import { SetMetadata } from '@nestjs/common';
import type { Env } from '../config/env.schema';

export const RATE_LIMIT_KEY = 'rateLimit';

export interface RateLimitOptions {
  windowMsEnvKey: keyof Env;
  maxAttemptsEnvKey: keyof Env;
}

/** Marks a handler for UserRateLimitGuard, reading its window/max-attempts from the named env vars at request time. */
export const RateLimit = (options: RateLimitOptions): MethodDecorator =>
  SetMetadata(RATE_LIMIT_KEY, options);
