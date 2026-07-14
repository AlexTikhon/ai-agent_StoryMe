import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiterService } from './rate-limiter.service';

describe('RateLimiterService', () => {
  let limiter: RateLimiterService;

  beforeEach(() => {
    limiter = new RateLimiterService();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests below the max attempts', async () => {
    const first = await limiter.consume('k', 1000, 3);
    const second = await limiter.consume('k', 1000, 3);
    const third = await limiter.consume('k', 1000, 3);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
  });

  it('blocks once max attempts is exceeded within the window', async () => {
    await limiter.consume('k', 1000, 3);
    await limiter.consume('k', 1000, 3);
    await limiter.consume('k', 1000, 3);

    const fourth = await limiter.consume('k', 1000, 3);

    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it('resets the count once the window elapses', async () => {
    await limiter.consume('k', 1000, 1);
    expect((await limiter.consume('k', 1000, 1)).allowed).toBe(false);

    vi.setSystemTime(new Date('2026-01-01T00:00:01.001Z'));

    expect((await limiter.consume('k', 1000, 1)).allowed).toBe(true);
  });

  it('tracks separate keys independently', async () => {
    await limiter.consume('a', 1000, 1);
    const blockedA = await limiter.consume('a', 1000, 1);
    const allowedB = await limiter.consume('b', 1000, 1);

    expect(blockedA.allowed).toBe(false);
    expect(allowedB.allowed).toBe(true);
  });

  it('reset() clears all counters', async () => {
    await limiter.consume('k', 1000, 1);
    expect((await limiter.consume('k', 1000, 1)).allowed).toBe(false);

    limiter.reset();

    expect((await limiter.consume('k', 1000, 1)).allowed).toBe(true);
  });
});
