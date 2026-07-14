import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT_TOKEN } from '../redis/redis.module';
import type { RateLimiter, RateLimitResult } from './rate-limiter.interface';

/**
 * Atomic fixed-window counter: INCR the key, and on the first hit in a fresh
 * window (count == 1) set its expiry to the window length. Both commands run
 * inside one Lua script, so this is race-free even across many API/worker
 * instances hitting the same key concurrently — the property the old
 * process-local RateLimiterService could never provide (see its own doc
 * comment). Returns [count, remainingTtlMs] so the caller can compute
 * allowed/remaining/retryAfterMs without a second round-trip.
 */
const CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

/**
 * Production rate limiter — backed by the shared Redis connection (see
 * ../redis/redis.module.ts), correct across every API/worker instance since
 * Redis, not process memory, holds the counters. REDIS_URL is already a
 * required env var (BullMQ depends on it), so this has no new deployment
 * requirement.
 */
@Injectable()
export class RedisRateLimiter implements RateLimiter {
  constructor(@Inject(REDIS_CLIENT_TOKEN) private readonly redis: Redis) {}

  async consume(key: string, windowMs: number, maxAttempts: number): Promise<RateLimitResult> {
    const [count, ttl] = (await this.redis.eval(CONSUME_SCRIPT, 1, key, windowMs)) as [
      number,
      number,
    ];
    const allowed = count <= maxAttempts;
    return {
      allowed,
      remaining: Math.max(0, maxAttempts - count),
      retryAfterMs: ttl > 0 ? ttl : windowMs,
    };
  }
}
