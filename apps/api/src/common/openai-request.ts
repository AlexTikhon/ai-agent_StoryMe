export const DEFAULT_OPENAI_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_OPENAI_MAX_RETRIES = 2;

/**
 * Real image generation/edit calls (multipart character-reference uploads to
 * gpt-image-1) routinely take well over 60s, so they get their own, longer,
 * independently configured timeout instead of sharing OPENAI_REQUEST_TIMEOUT_MS
 * with the (fast) text providers — see readOpenAIImageTimeoutConfig and
 * OpenAIImageGenerationProvider.
 */
export const DEFAULT_OPENAI_IMAGE_REQUEST_TIMEOUT_MS = 240_000;
export const MIN_OPENAI_IMAGE_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_OPENAI_IMAGE_REQUEST_TIMEOUT_MS = 600_000;
/** A slow-but-working image request shouldn't be retried into 2x/3x its own timeout, so this defaults much lower than DEFAULT_OPENAI_MAX_RETRIES. */
export const DEFAULT_OPENAI_IMAGE_TIMEOUT_MAX_RETRIES = 1;

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

export interface OpenAIRetryConfig {
  timeoutMs: number;
  maxRetries: number;
}

/**
 * Reads OPENAI_REQUEST_TIMEOUT_MS / OPENAI_MAX_RETRIES from env, falling
 * back to safe defaults when missing or malformed so a provider never ends
 * up with an unbounded timeout or a negative retry count.
 */
export function readOpenAIRetryConfig(env: NodeJS.ProcessEnv = process.env): OpenAIRetryConfig {
  return {
    timeoutMs: parsePositiveInt(
      env['OPENAI_REQUEST_TIMEOUT_MS'],
      DEFAULT_OPENAI_REQUEST_TIMEOUT_MS,
    ),
    maxRetries: parseNonNegativeInt(env['OPENAI_MAX_RETRIES'], DEFAULT_OPENAI_MAX_RETRIES),
  };
}

export interface OpenAIImageTimeoutConfig {
  timeoutMs: number;
  timeoutMaxRetries: number;
}

/**
 * Reads OPENAI_IMAGE_REQUEST_TIMEOUT_MS / OPENAI_IMAGE_TIMEOUT_MAX_RETRIES —
 * deliberately independent from readOpenAIRetryConfig, which stays text-only
 * (OpenAIStoryGenerationProvider / OpenAICharacterProfileProvider) and keeps
 * its existing 60s/2-retry defaults untouched. timeoutMs is clamped to
 * [MIN_OPENAI_IMAGE_REQUEST_TIMEOUT_MS, MAX_OPENAI_IMAGE_REQUEST_TIMEOUT_MS];
 * an out-of-range or malformed value falls back to the default rather than
 * silently clamping to the nearest bound, so a badly-set env var is obvious
 * from the resulting (unchanged) timeout rather than a surprising clamp.
 */
export function readOpenAIImageTimeoutConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpenAIImageTimeoutConfig {
  const rawTimeout = env['OPENAI_IMAGE_REQUEST_TIMEOUT_MS'];
  const parsedTimeout = rawTimeout ? Number(rawTimeout) : NaN;
  const timeoutMs =
    Number.isFinite(parsedTimeout) &&
    parsedTimeout >= MIN_OPENAI_IMAGE_REQUEST_TIMEOUT_MS &&
    parsedTimeout <= MAX_OPENAI_IMAGE_REQUEST_TIMEOUT_MS
      ? Math.floor(parsedTimeout)
      : DEFAULT_OPENAI_IMAGE_REQUEST_TIMEOUT_MS;
  return {
    timeoutMs,
    timeoutMaxRetries: parseNonNegativeInt(
      env['OPENAI_IMAGE_TIMEOUT_MAX_RETRIES'],
      DEFAULT_OPENAI_IMAGE_TIMEOUT_MAX_RETRIES,
    ),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export type OpenAIRequestFailureReason = 'timeout' | 'network';

/**
 * Thrown by fetchWithRetry when every attempt fails on a network error or
 * timeout (never for a non-2xx HTTP response — callers keep inspecting
 * response.ok/status themselves so 400/401/403 stay non-retryable).
 */
export class OpenAIRequestError extends Error {
  constructor(
    message: string,
    readonly reason: OpenAIRequestFailureReason,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'OpenAIRequestError';
  }
}

/**
 * Stable message safe to persist in Book/AgentLog diagnostics. The original
 * network error remains available through `cause` for in-process debugging,
 * but its provider/runtime-defined text is never copied into user-visible
 * state.
 */
export function safeOpenAIRequestFailureMessage(err: unknown): string {
  if (err instanceof OpenAIRequestError) {
    return err.reason === 'timeout'
      ? 'OpenAI request timed out'
      : 'OpenAI request failed due to a network error';
  }
  return 'OpenAI request failed unexpectedly';
}

export interface FetchWithRetryOptions {
  fetchImpl: typeof fetch;
  url: string;
  init: RequestInit;
  timeoutMs: number;
  maxRetries: number;
  /**
   * Independent retry budget for request-timeout (AbortError) failures only;
   * network errors and retryable HTTP statuses keep using maxRetries.
   * Defaults to maxRetries when omitted, which preserves the exact prior
   * behavior (a timeout consumed the same shared budget as a network error)
   * for every existing caller — only OpenAIImageGenerationProvider passes a
   * distinct value (OPENAI_IMAGE_TIMEOUT_MAX_RETRIES) so a slow-but-working
   * image request isn't retried into multiples of its own (much longer)
   * timeout.
   */
  timeoutMaxRetries?: number;
  onAttempt?: (attempt: number, maxAttempts: number) => void;
  onRetry?: (attempt: number, reason: string) => void;
  /**
   * Overrides which non-2xx statuses are retried internally; defaults to the
   * standard transient set (408/429/500/502/503/504). OpenAIImageGenerationProvider
   * passes a set without 429 so 429 is returned on the first attempt instead —
   * OpenAIImageRateLimiter owns 429 retry/backoff/Retry-After handling for image
   * requests, since it needs to coordinate across concurrent calls in a way this
   * function (one request at a time) cannot.
   */
  retryableStatusCodes?: ReadonlySet<number>;
}

/**
 * POSTs via fetchImpl with a per-attempt AbortController timeout and a
 * small backoff retry on transient failures: network errors, timeouts, and
 * retryable HTTP statuses (408/429/500/502/503/504). Non-retryable HTTP
 * responses are returned as-is on the first attempt — callers keep handling
 * response.ok/status themselves, so 400/401/403 never retry. Timeout
 * (AbortError) retries are tracked against their own budget
 * (timeoutMaxRetries), separate from the budget used by network errors and
 * retryable HTTP statuses (maxRetries) — see FetchWithRetryOptions.
 */
export async function fetchWithRetry(options: FetchWithRetryOptions): Promise<Response> {
  const {
    fetchImpl,
    url,
    init,
    timeoutMs,
    maxRetries,
    timeoutMaxRetries = maxRetries,
    onAttempt,
    onRetry,
    retryableStatusCodes = RETRYABLE_STATUS_CODES,
  } = options;
  const maxAttemptsForDisplay = 1 + Math.max(maxRetries, timeoutMaxRetries);

  let otherRetriesUsed = 0;
  let timeoutRetriesUsed = 0;

  for (let attempt = 1; ; attempt++) {
    onAttempt?.(attempt, maxAttemptsForDisplay);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      if (
        !response.ok &&
        retryableStatusCodes.has(response.status) &&
        otherRetriesUsed < maxRetries
      ) {
        otherRetriesUsed++;
        onRetry?.(attempt, `http_${response.status}`);
        await delay(backoffMs(attempt));
        continue;
      }
      return response;
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const reason: OpenAIRequestFailureReason = isAbort ? 'timeout' : 'network';
      const canRetry = isAbort
        ? timeoutRetriesUsed < timeoutMaxRetries
        : otherRetriesUsed < maxRetries;
      if (canRetry) {
        if (isAbort) timeoutRetriesUsed++;
        else otherRetriesUsed++;
        onRetry?.(attempt, reason);
        await delay(backoffMs(attempt));
        continue;
      }
      const message = isAbort
        ? `request timed out after ${timeoutMs}ms`
        : `request failed: ${err instanceof Error ? err.message : String(err)}`;
      throw new OpenAIRequestError(message, reason, err);
    } finally {
      clearTimeout(timer);
    }
  }
}

function backoffMs(attempt: number): number {
  return Math.min(250 * 2 ** (attempt - 1), 2000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
