import { describe, it, expect, vi } from 'vitest';
import type Redis from 'ioredis';
import { RedisRateLimiter } from './redis-rate-limiter.service';

/** Minimal fake standing in for the real Lua-script fixed-window counter — enough to exercise RedisRateLimiter's own logic without a live Redis connection. */
function createFakeRedis(): { redis: Redis; buckets: Map<string, { count: number; resetAt: number }> } {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const eval_ = vi.fn(async (_script: string, _numKeys: number, key: string, windowMs: number) => {
    const now = Date.now();
    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return [1, windowMs];
    }
    existing.count += 1;
    return [existing.count, existing.resetAt - now];
  });
  return { redis: { eval: eval_ } as unknown as Redis, buckets };
}

describe('RedisRateLimiter', () => {
  it('allows requests below max attempts and reports remaining correctly', async () => {
    const { redis } = createFakeRedis();
    const limiter = new RedisRateLimiter(redis);

    const first = await limiter.consume('k', 1000, 3);
    const second = await limiter.consume('k', 1000, 3);
    const third = await limiter.consume('k', 1000, 3);

    expect(first).toEqual({ allowed: true, remaining: 2, retryAfterMs: 1000 });
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(1);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
  });

  it('blocks once max attempts is exceeded within the window', async () => {
    const { redis } = createFakeRedis();
    const limiter = new RedisRateLimiter(redis);

    await limiter.consume('k', 1000, 2);
    await limiter.consume('k', 1000, 2);
    const third = await limiter.consume('k', 1000, 2);

    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  it('tracks separate keys independently', async () => {
    const { redis } = createFakeRedis();
    const limiter = new RedisRateLimiter(redis);

    await limiter.consume('a', 1000, 1);
    const blockedA = await limiter.consume('a', 1000, 1);
    const allowedB = await limiter.consume('b', 1000, 1);

    expect(blockedA.allowed).toBe(false);
    expect(allowedB.allowed).toBe(true);
  });

  it('issues a single atomic EVAL call per consume (no separate read-then-write round trip)', async () => {
    const { redis } = createFakeRedis();
    const limiter = new RedisRateLimiter(redis);

    await limiter.consume('k', 1000, 3);

    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 1, 'k', 1000);
  });
});
