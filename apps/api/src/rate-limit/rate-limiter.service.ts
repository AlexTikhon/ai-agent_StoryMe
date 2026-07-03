import { Injectable } from '@nestjs/common';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window in-memory rate limiter. One process-local Map keyed by an
 * arbitrary caller-supplied string — callers own key composition (e.g.
 * IP + route + identifier), this service only owns the counting.
 *
 * Single-process only: state is not shared across instances, so this is
 * only correct for a single-instance deploy (matches this app's current
 * in-process GenerationTaskRunner assumption — see
 * docs/deployment-readiness.md). A multi-instance deploy needs a shared
 * store (e.g. Redis, which this app already provisions for other purposes)
 * behind the same consume()/reset() shape.
 */
@Injectable()
export class RateLimiterService {
  private readonly buckets = new Map<string, Bucket>();

  consume(key: string, windowMs: number, maxAttempts: number): RateLimitResult {
    const now = Date.now();
    const existing = this.buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: maxAttempts - 1, retryAfterMs: windowMs };
    }

    if (existing.count >= maxAttempts) {
      return { allowed: false, remaining: 0, retryAfterMs: existing.resetAt - now };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: maxAttempts - existing.count,
      retryAfterMs: existing.resetAt - now,
    };
  }

  /** Clears all counters. Intended for test isolation between spec cases. */
  reset(): void {
    this.buckets.clear();
  }
}
