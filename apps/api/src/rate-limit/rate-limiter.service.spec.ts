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

  it('allows requests below the max attempts', () => {
    const first = limiter.consume('k', 1000, 3);
    const second = limiter.consume('k', 1000, 3);
    const third = limiter.consume('k', 1000, 3);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
  });

  it('blocks once max attempts is exceeded within the window', () => {
    limiter.consume('k', 1000, 3);
    limiter.consume('k', 1000, 3);
    limiter.consume('k', 1000, 3);

    const fourth = limiter.consume('k', 1000, 3);

    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it('resets the count once the window elapses', () => {
    limiter.consume('k', 1000, 1);
    expect(limiter.consume('k', 1000, 1).allowed).toBe(false);

    vi.setSystemTime(new Date('2026-01-01T00:00:01.001Z'));

    expect(limiter.consume('k', 1000, 1).allowed).toBe(true);
  });

  it('tracks separate keys independently', () => {
    limiter.consume('a', 1000, 1);
    const blockedA = limiter.consume('a', 1000, 1);
    const allowedB = limiter.consume('b', 1000, 1);

    expect(blockedA.allowed).toBe(false);
    expect(allowedB.allowed).toBe(true);
  });

  it('reset() clears all counters', () => {
    limiter.consume('k', 1000, 1);
    expect(limiter.consume('k', 1000, 1).allowed).toBe(false);

    limiter.reset();

    expect(limiter.consume('k', 1000, 1).allowed).toBe(true);
  });
});
