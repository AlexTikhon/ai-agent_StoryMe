import { Global, Module } from '@nestjs/common';
import { RateLimiterService } from './rate-limiter.service';

/**
 * Generic, reusable in-memory rate limiting building block — not auth-specific.
 * See RateLimiterService for the single-process caveat and the production
 * (Redis-backed) upgrade path. AuthRateLimitGuard (apps/api/src/auth/) is the
 * only current consumer, but any future endpoint can inject RateLimiterService
 * directly.
 */
@Global()
@Module({
  providers: [RateLimiterService],
  exports: [RateLimiterService],
})
export class RateLimitModule {}
