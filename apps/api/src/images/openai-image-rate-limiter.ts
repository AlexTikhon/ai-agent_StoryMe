import { Logger } from '@nestjs/common';
import type { ProviderExecutionOptions } from '../common/provider-execution';
import {
  cancellableSleep,
  ProviderCancellationError,
  reportProviderMetrics,
  throwIfAborted,
} from '../common/provider-execution';
import type { ProviderCallMetrics } from '@book/types';
import type { ProviderQuotaGate } from './provider-quota-gate';

export const DEFAULT_OPENAI_IMAGE_MIN_INTERVAL_MS = 15_000;
export const DEFAULT_OPENAI_IMAGE_MAX_RETRIES = 5;
export const DEFAULT_OPENAI_IMAGE_RETRY_BASE_MS = 12_000;
export const DEFAULT_OPENAI_IMAGE_RETRY_MAX_MS = 60_000;
export const DEFAULT_OPENAI_IMAGE_MAX_WAIT_MS = 10 * 60_000;
export const DEFAULT_OPENAI_IMAGE_MAX_CONCURRENCY = 1;
export const DEFAULT_OPENAI_IMAGE_CONCURRENCY_LEASE_MS = 5 * 60_000;

export interface OpenAIImageRateLimiterConfig {
  minIntervalMs: number;
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  maxWaitMs: number;
  maxConcurrency: number;
  concurrencyLeaseMs: number;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Reads OPENAI_IMAGE_MIN_INTERVAL_MS / OPENAI_IMAGE_MAX_RETRIES /
 * OPENAI_IMAGE_RETRY_BASE_MS / OPENAI_IMAGE_RETRY_MAX_MS from env, falling
 * back to conservative defaults (matched to a Tier-1-style 5-image/min quota)
 * for missing or malformed values. retryMaxMs is clamped to never be below
 * retryBaseMs so the backoff formula in computeBackoffMs stays well-defined.
 */
export function readOpenAIImageRateLimiterConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpenAIImageRateLimiterConfig {
  const minIntervalMs = parseNonNegativeInt(
    env['OPENAI_IMAGE_MIN_INTERVAL_MS'],
    DEFAULT_OPENAI_IMAGE_MIN_INTERVAL_MS,
  );
  const maxRetries = parseNonNegativeInt(
    env['OPENAI_IMAGE_MAX_RETRIES'],
    DEFAULT_OPENAI_IMAGE_MAX_RETRIES,
  );
  const retryBaseMs = parsePositiveInt(
    env['OPENAI_IMAGE_RETRY_BASE_MS'],
    DEFAULT_OPENAI_IMAGE_RETRY_BASE_MS,
  );
  const retryMaxMs = Math.max(
    parsePositiveInt(env['OPENAI_IMAGE_RETRY_MAX_MS'], DEFAULT_OPENAI_IMAGE_RETRY_MAX_MS),
    retryBaseMs,
  );
  const maxWaitMs = parsePositiveInt(
    env['OPENAI_IMAGE_MAX_WAIT_MS'],
    DEFAULT_OPENAI_IMAGE_MAX_WAIT_MS,
  );
  const maxConcurrency = parsePositiveInt(
    env['OPENAI_IMAGE_MAX_CONCURRENCY'],
    DEFAULT_OPENAI_IMAGE_MAX_CONCURRENCY,
  );
  const concurrencyLeaseMs = parsePositiveInt(
    env['OPENAI_IMAGE_CONCURRENCY_LEASE_MS'],
    DEFAULT_OPENAI_IMAGE_CONCURRENCY_LEASE_MS,
  );
  return {
    minIntervalMs,
    maxRetries,
    retryBaseMs,
    retryMaxMs,
    maxWaitMs,
    maxConcurrency,
    concurrencyLeaseMs,
  };
}

export interface OpenAIImageRateLimiterGlobalDiagnostics {
  /** Total number of requests submitted via schedule() on this instance. */
  requestsQueued: number;
  /** Cumulative milliseconds spent waiting, across spacing waits and 429 backoff/Retry-After waits. */
  totalWaitMs: number;
  /** Number of HTTP 429 responses observed (including ones that were subsequently retried). */
  rateLimitHits: number;
  /** Number of retry attempts actually taken after a 429. */
  retriesUsed: number;
  /** Number of those retries whose wait duration came from a Retry-After header rather than computed backoff. */
  retryAfterHonoredCount: number;
}

interface MutableCallMetrics {
  rateLimitHits: number;
  retries: number;
  rateLimitWaitMs: number;
  retryAfterHonoredCount: number;
}

export interface OpenAIImageRateLimiterOptions extends Partial<OpenAIImageRateLimiterConfig> {
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
  /** Injectable sleeper for tests; defaults to a real setTimeout-based delay. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable jitter source (0-1) for tests; defaults to Math.random. */
  random?: () => number;
  logger?: Logger;
  sharedGate?: ProviderQuotaGate;
  quotaScope?: string;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return cancellableSleep(ms, signal);
}

/**
 * Parses a Retry-After header value (seconds, per the OpenAI/HTTP convention,
 * or an HTTP-date) into a millisecond wait duration. Returns undefined when
 * absent or unparseable, so the caller falls back to computed backoff.
 */
export function parseRetryAfterMs(
  raw: string | null | undefined,
  now: () => number = Date.now,
): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now());
  return undefined;
}

/**
 * Process-wide gate for every OpenAI image generation/edit request made by
 * this API instance (character sheet, cover, pages, back cover, and any
 * future regeneration path) — see OpenAIImageGenerationProvider, which is
 * constructed once per process (image-generation-provider.factory.ts) and
 * shares a single limiter instance across all of its calls.
 *
 * Responsibilities kept deliberately narrow:
 *  - Serializes every call through schedule() (a promise-chain queue) and
 *    enforces at least minIntervalMs between successive request dispatches,
 *    so concurrent callers (e.g. AgentService's Promise.all over a book's
 *    pages) never burst past the org's images-per-minute quota.
 *  - Owns 429 retry policy exclusively: honors Retry-After when the response
 *    provides one, otherwise waits an exponential-backoff-with-jitter
 *    duration (bounded by retryBaseMs/retryMaxMs), up to maxRetries.
 *  - Does NOT retry network errors/timeouts or other HTTP statuses — those
 *    are unrelated failure modes already handled by fetchWithRetry inside
 *    the dispatch function passed in; a thrown error from dispatch()
 *    propagates immediately so existing fallback-to-placeholder behavior is
 *    unchanged.
 */
export class OpenAIImageRateLimiter {
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly logger: Logger;
  private readonly maxWaitMs: number;
  private readonly maxConcurrency: number;
  private readonly concurrencyLeaseMs: number;
  private readonly sharedGate: ProviderQuotaGate | undefined;
  private readonly quotaScope: string;

  private queueTail: Promise<void> = Promise.resolve();
  private lastDispatchAt: number | undefined;

  private readonly diagnostics: OpenAIImageRateLimiterGlobalDiagnostics = {
    requestsQueued: 0,
    totalWaitMs: 0,
    rateLimitHits: 0,
    retriesUsed: 0,
    retryAfterHonoredCount: 0,
  };

  constructor(options: OpenAIImageRateLimiterOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_OPENAI_IMAGE_MIN_INTERVAL_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_OPENAI_IMAGE_MAX_RETRIES;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_OPENAI_IMAGE_RETRY_BASE_MS;
    this.retryMaxMs = Math.max(
      options.retryMaxMs ?? DEFAULT_OPENAI_IMAGE_RETRY_MAX_MS,
      this.retryBaseMs,
    );
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.logger = options.logger ?? new Logger(OpenAIImageRateLimiter.name);
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_OPENAI_IMAGE_MAX_WAIT_MS;
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_OPENAI_IMAGE_MAX_CONCURRENCY;
    this.concurrencyLeaseMs =
      options.concurrencyLeaseMs ?? DEFAULT_OPENAI_IMAGE_CONCURRENCY_LEASE_MS;
    this.sharedGate = options.sharedGate;
    this.quotaScope = options.quotaScope ?? 'openai:image';
  }

  /** Process-lifetime operator diagnostics; never use as one generation's metrics. */
  getGlobalDiagnostics(): OpenAIImageRateLimiterGlobalDiagnostics {
    return { ...this.diagnostics };
  }

  /**
   * Runs `dispatch` under the shared limiter: serialized against every other
   * schedule() call on this instance, spaced at least minIntervalMs apart,
   * and retried on HTTP 429 up to maxRetries. `dispatch` must perform exactly
   * one request attempt and resolve with a response-like value exposing status
   * and headers (never throw for a non-2xx status, so 429s can be inspected
   * here) — a thrown error (network/timeout) propagates immediately without an
   * extra retry at this layer.
   */
  schedule<T extends Pick<Response, 'status'> & { headers?: Headers | undefined }>(
    label: string,
    dispatch: () => Promise<T>,
    options: ProviderExecutionOptions = {},
  ): Promise<T> {
    this.diagnostics.requestsQueued++;
    const callMetrics: MutableCallMetrics = {
      rateLimitHits: 0,
      retries: 0,
      rateLimitWaitMs: 0,
      retryAfterHonoredCount: 0,
    };
    const run = this.queueTail.then(() =>
      this.runSlot(label, dispatch, callMetrics, options.signal),
    );
    // Keep the chain alive regardless of this request's outcome so a failure
    // never wedges every subsequent queued request.
    this.queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return this.raceWithCancellation(run, options.signal).finally(() => {
      reportProviderMetrics(options, callMetrics satisfies ProviderCallMetrics);
    });
  }

  private async runSlot<T extends Pick<Response, 'status'> & { headers?: Headers | undefined }>(
    label: string,
    dispatch: () => Promise<T>,
    metrics: MutableCallMetrics,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(signal);
    const maxAttempts = this.maxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      throwIfAborted(signal);
      const release = await this.waitForSpacing(label, metrics, signal);
      let response: T;
      try {
        throwIfAborted(signal);
        response = await dispatch();
      } finally {
        await release();
      }
      if (response.status !== 429) return response;

      this.diagnostics.rateLimitHits++;
      metrics.rateLimitHits++;
      if (attempt === maxAttempts) {
        this.logger.warn(
          `${label}: exhausted ${this.maxRetries} rate-limit retries; still receiving HTTP 429`,
        );
        return response;
      }

      this.diagnostics.retriesUsed++;
      metrics.retries++;
      const retryAfterMs = parseRetryAfterMs(response.headers?.get('retry-after'), this.now);
      await this.waitBeforeRetry(label, attempt, retryAfterMs, metrics, signal);
    }

    /* istanbul ignore next -- loop above always returns */
    throw new Error('unreachable');
  }

  private async waitForSpacing(
    label: string,
    metrics: MutableCallMetrics,
    signal?: AbortSignal,
  ): Promise<() => Promise<void>> {
    if (this.sharedGate) {
      const permit = await this.sharedGate.acquire(
        this.quotaScope,
        this.minIntervalMs,
        this.maxWaitMs,
        this.maxConcurrency,
        this.concurrencyLeaseMs,
        signal,
      );
      this.diagnostics.totalWaitMs += permit.waitMs;
      metrics.rateLimitWaitMs += permit.waitMs;
      this.lastDispatchAt = this.now();
      return () => permit.release();
    }
    const now = this.now();
    if (this.lastDispatchAt !== undefined) {
      const waitMs = this.minIntervalMs - (now - this.lastDispatchAt);
      if (waitMs > 0) {
        this.diagnostics.totalWaitMs += waitMs;
        metrics.rateLimitWaitMs += waitMs;
        this.logger.log(`${label}: waiting ${waitMs}ms for the OpenAI image rate limit`);
        await this.sleepWithCancellation(waitMs, signal);
      }
    }
    throwIfAborted(signal);
    this.lastDispatchAt = this.now();
    return async () => undefined;
  }

  private async waitBeforeRetry(
    label: string,
    attempt: number,
    retryAfterMs: number | undefined,
    metrics: MutableCallMetrics,
    signal?: AbortSignal,
  ): Promise<void> {
    let waitMs: number;
    if (retryAfterMs !== undefined) {
      waitMs = retryAfterMs;
      this.diagnostics.retryAfterHonoredCount++;
      metrics.retryAfterHonoredCount++;
    } else {
      waitMs = this.computeBackoffMs(attempt);
    }
    this.diagnostics.totalWaitMs += waitMs;
    metrics.rateLimitWaitMs += waitMs;
    this.logger.warn(
      `${label}: HTTP 429 (rate limited), waiting ${waitMs}ms before retry ${attempt + 1}/${this.maxRetries + 1} (retryAfterHonored=${retryAfterMs !== undefined})`,
    );
    await this.sleepWithCancellation(waitMs, signal);
  }

  private sleepWithCancellation(ms: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    return this.raceWithCancellation(this.sleep(ms, signal), signal);
  }

  private raceWithCancellation<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    throwIfAborted(signal);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new ProviderCancellationError(signal.reason));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  /** Exponential backoff bounded by retryMaxMs, plus up to 20% jitter (also bounded by retryMaxMs) so retries don't all land on the same instant. */
  private computeBackoffMs(attempt: number): number {
    const exp = Math.min(this.retryBaseMs * 2 ** (attempt - 1), this.retryMaxMs);
    const jitter = exp * 0.2 * this.random();
    return Math.min(Math.round(exp + jitter), this.retryMaxMs);
  }
}
