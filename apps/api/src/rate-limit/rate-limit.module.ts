import { Global, Module } from '@nestjs/common';
import { RateLimiterService } from './rate-limiter.service';
import { RedisRateLimiter } from './redis-rate-limiter.service';
import { RATE_LIMITER_TOKEN } from './rate-limiter.interface';
import { UserRateLimitGuard } from './user-rate-limit.guard';

/**
 * Generic, reusable rate limiting building block — not auth-specific.
 * RATE_LIMITER_TOKEN resolves to RedisRateLimiter everywhere at runtime
 * (correct across every API/worker instance, since REDIS_URL is already a
 * required env var for BullMQ); RateLimiterService (in-memory) stays
 * available for direct injection in unit tests that construct a guard/service
 * without a Redis connection. AuthRateLimitGuard and books-related guards
 * (apps/api/src/auth/, apps/api/src/books/) are the current consumers.
 */
@Global()
@Module({
  providers: [
    RateLimiterService,
    {
      provide: RATE_LIMITER_TOKEN,
      useClass: RedisRateLimiter,
    },
    UserRateLimitGuard,
  ],
  exports: [RateLimiterService, RATE_LIMITER_TOKEN, UserRateLimitGuard],
})
export class RateLimitModule {}
