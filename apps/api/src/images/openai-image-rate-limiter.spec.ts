import { describe, it, expect, vi } from 'vitest';
import {
  OpenAIImageRateLimiter,
  readOpenAIImageRateLimiterConfig,
  parseRetryAfterMs,
  DEFAULT_OPENAI_IMAGE_MIN_INTERVAL_MS,
  DEFAULT_OPENAI_IMAGE_MAX_RETRIES,
  DEFAULT_OPENAI_IMAGE_RETRY_BASE_MS,
  DEFAULT_OPENAI_IMAGE_RETRY_MAX_MS,
} from './openai-image-rate-limiter';

/**
 * A fake clock/sleeper pair: sleep(ms) instantly advances the fake clock by
 * ms and resolves, so tests exercise the real backoff/spacing math without
 * any real waiting (no vi.useFakeTimers() needed).
 */
function makeFakeClock(startAt = 0) {
  let time = startAt;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

function okResponse(): Response {
  return { ok: true, status: 200, headers: { get: () => null } } as unknown as Response;
}

function rateLimitedResponse(retryAfter: string | null = null): Response {
  return {
    ok: false,
    status: 429,
    headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
  } as unknown as Response;
}

describe('readOpenAIImageRateLimiterConfig', () => {
  it('falls back to safe conservative defaults when env vars are missing', () => {
    expect(readOpenAIImageRateLimiterConfig({} as NodeJS.ProcessEnv)).toEqual({
      minIntervalMs: DEFAULT_OPENAI_IMAGE_MIN_INTERVAL_MS,
      maxRetries: DEFAULT_OPENAI_IMAGE_MAX_RETRIES,
      retryBaseMs: DEFAULT_OPENAI_IMAGE_RETRY_BASE_MS,
      retryMaxMs: DEFAULT_OPENAI_IMAGE_RETRY_MAX_MS,
    });
  });

  it('reads valid env vars', () => {
    const config = readOpenAIImageRateLimiterConfig({
      OPENAI_IMAGE_MIN_INTERVAL_MS: '20000',
      OPENAI_IMAGE_MAX_RETRIES: '3',
      OPENAI_IMAGE_RETRY_BASE_MS: '5000',
      OPENAI_IMAGE_RETRY_MAX_MS: '30000',
    } as unknown as NodeJS.ProcessEnv);
    expect(config).toEqual({
      minIntervalMs: 20000,
      maxRetries: 3,
      retryBaseMs: 5000,
      retryMaxMs: 30000,
    });
  });

  it('falls back to defaults for malformed values', () => {
    const config = readOpenAIImageRateLimiterConfig({
      OPENAI_IMAGE_MIN_INTERVAL_MS: 'nope',
      OPENAI_IMAGE_MAX_RETRIES: '-1',
      OPENAI_IMAGE_RETRY_BASE_MS: '0',
      OPENAI_IMAGE_RETRY_MAX_MS: 'nope',
    } as unknown as NodeJS.ProcessEnv);
    expect(config).toEqual({
      minIntervalMs: DEFAULT_OPENAI_IMAGE_MIN_INTERVAL_MS,
      maxRetries: DEFAULT_OPENAI_IMAGE_MAX_RETRIES,
      retryBaseMs: DEFAULT_OPENAI_IMAGE_RETRY_BASE_MS,
      retryMaxMs: DEFAULT_OPENAI_IMAGE_RETRY_MAX_MS,
    });
  });

  it('clamps retryMaxMs up to retryBaseMs when configured backwards', () => {
    const config = readOpenAIImageRateLimiterConfig({
      OPENAI_IMAGE_RETRY_BASE_MS: '20000',
      OPENAI_IMAGE_RETRY_MAX_MS: '5000',
    } as unknown as NodeJS.ProcessEnv);
    expect(config.retryMaxMs).toBe(20000);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses a numeric seconds value', () => {
    expect(parseRetryAfterMs('12')).toBe(12000);
  });

  it('parses an HTTP-date value relative to now', () => {
    const now = () => 1_000_000;
    expect(parseRetryAfterMs(new Date(1_000_000 + 5000).toUTCString(), now)).toBe(5000);
  });

  it('returns undefined when absent', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });

  it('returns undefined for an unparseable value', () => {
    expect(parseRetryAfterMs('not-a-duration')).toBeUndefined();
  });
});

describe('OpenAIImageRateLimiter', () => {
  it('serializes requests: a second schedule() call does not dispatch until the first resolves', async () => {
    const clock = makeFakeClock();
    const limiter = new OpenAIImageRateLimiter({
      minIntervalMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    });

    const order: string[] = [];
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (resolveFirst = resolve));

    const first = limiter.schedule('first', async () => {
      order.push('first-start');
      await firstGate;
      order.push('first-end');
      return okResponse();
    });
    const second = limiter.schedule('second', async () => {
      order.push('second-start');
      return okResponse();
    });

    // Give both scheduled promises a chance to progress; only the first
    // request's dispatch should have started.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first-start']);

    resolveFirst();
    await first;
    await second;

    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('honors the configured minimum interval between successive requests', async () => {
    const clock = makeFakeClock();
    const limiter = new OpenAIImageRateLimiter({
      minIntervalMs: 15_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    await limiter.schedule('first', async () => okResponse());
    await limiter.schedule('second', async () => okResponse());

    expect(clock.now()).toBe(15_000);
    expect(limiter.getDiagnostics().totalWaitMs).toBe(15_000);
  });

  it('does not wait before the very first request', async () => {
    const clock = makeFakeClock();
    const limiter = new OpenAIImageRateLimiter({
      minIntervalMs: 15_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    await limiter.schedule('first', async () => okResponse());

    expect(clock.now()).toBe(0);
  });

  it('honors Retry-After when present instead of computed backoff', async () => {
    const clock = makeFakeClock();
    const limiter = new OpenAIImageRateLimiter({
      minIntervalMs: 0,
      maxRetries: 2,
      now: clock.now,
      sleep: clock.sleep,
    });

    const dispatch = vi
      .fn()
      .mockResolvedValueOnce(rateLimitedResponse('7'))
      .mockResolvedValueOnce(okResponse());

    const response = await limiter.schedule('img', dispatch);

    expect(response.ok).toBe(true);
    expect(clock.now()).toBe(7000);
    const diagnostics = limiter.getDiagnostics();
    expect(diagnostics.retryAfterHonoredCount).toBe(1);
    expect(diagnostics.rateLimitHits).toBe(1);
    expect(diagnostics.retriesUsed).toBe(1);
  });

  it('applies exponential backoff with bounded jitter when Retry-After is absent', async () => {
    const clock = makeFakeClock();
    const limiter = new OpenAIImageRateLimiter({
      minIntervalMs: 0,
      maxRetries: 3,
      retryBaseMs: 1000,
      retryMaxMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 1, // maximum jitter
    });

    const dispatch = vi
      .fn()
      .mockResolvedValueOnce(rateLimitedResponse())
      .mockResolvedValueOnce(okResponse());

    await limiter.schedule('img', dispatch);

    // attempt 1 backoff: base(1000) * 2^0 = 1000, + 20% jitter at random()=1 -> 1200
    expect(clock.now()).toBe(1200);
    expect(limiter.getDiagnostics().retryAfterHonoredCount).toBe(0);
  });

  it('keeps jitter within the bounded range [exp, retryMaxMs]', async () => {
    for (const randomValue of [0, 0.5, 1]) {
      const clock = makeFakeClock();
      const limiter = new OpenAIImageRateLimiter({
        minIntervalMs: 0,
        maxRetries: 1,
        retryBaseMs: 2000,
        retryMaxMs: 5000,
        now: clock.now,
        sleep: clock.sleep,
        random: () => randomValue,
      });
      const dispatch = vi
        .fn()
        .mockResolvedValueOnce(rateLimitedResponse())
        .mockResolvedValueOnce(okResponse());

      await limiter.schedule('img', dispatch);

      const waited = clock.now();
      expect(waited).toBeGreaterThanOrEqual(2000);
      expect(waited).toBeLessThanOrEqual(5000);
    }
  });

  it('stops retrying once maxRetries is exhausted and returns the last 429 response', async () => {
    const clock = makeFakeClock();
    const limiter = new OpenAIImageRateLimiter({
      minIntervalMs: 0,
      maxRetries: 2,
      retryBaseMs: 10,
      retryMaxMs: 10,
      now: clock.now,
      sleep: clock.sleep,
    });

    const dispatch = vi.fn().mockResolvedValue(rateLimitedResponse());

    const response = await limiter.schedule('img', dispatch);

    expect(response.status).toBe(429);
    expect(dispatch).toHaveBeenCalledTimes(3); // 1 initial attempt + 2 retries
    expect(limiter.getDiagnostics().rateLimitHits).toBe(3);
    expect(limiter.getDiagnostics().retriesUsed).toBe(2);
  });

  it('a successful retry returns the successful response', async () => {
    const clock = makeFakeClock();
    const limiter = new OpenAIImageRateLimiter({
      minIntervalMs: 0,
      maxRetries: 5,
      retryBaseMs: 10,
      now: clock.now,
      sleep: clock.sleep,
    });

    const dispatch = vi
      .fn()
      .mockResolvedValueOnce(rateLimitedResponse())
      .mockResolvedValueOnce(rateLimitedResponse())
      .mockResolvedValueOnce(okResponse());

    const response = await limiter.schedule('img', dispatch);

    expect(response.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it('propagates a thrown error from dispatch immediately without retrying it', async () => {
    const clock = makeFakeClock();
    const limiter = new OpenAIImageRateLimiter({
      minIntervalMs: 0,
      maxRetries: 5,
      now: clock.now,
      sleep: clock.sleep,
    });

    const dispatch = vi.fn().mockRejectedValue(new Error('network down'));

    await expect(limiter.schedule('img', dispatch)).rejects.toThrow('network down');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(clock.now()).toBe(0);
  });
});
