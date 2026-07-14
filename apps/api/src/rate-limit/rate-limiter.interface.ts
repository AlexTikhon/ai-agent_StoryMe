export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

/**
 * A single fixed-window counter keyed by an arbitrary caller-supplied string
 * — callers own key composition (route + IP, route + user id, etc.), this
 * only owns the counting. `consume` is async so a distributed (Redis-backed)
 * implementation can back the same interface a single-process one does.
 */
export interface RateLimiter {
  consume(key: string, windowMs: number, maxAttempts: number): Promise<RateLimitResult>;
}

/** DI token for the RateLimiter implementation actually wired up at runtime (see rate-limit.module.ts). */
export const RATE_LIMITER_TOKEN = 'RATE_LIMITER';
