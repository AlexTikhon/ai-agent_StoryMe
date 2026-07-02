export const DEFAULT_OPENAI_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_OPENAI_MAX_RETRIES = 2;

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

export interface FetchWithRetryOptions {
  fetchImpl: typeof fetch;
  url: string;
  init: RequestInit;
  timeoutMs: number;
  maxRetries: number;
  onAttempt?: (attempt: number, maxAttempts: number) => void;
  onRetry?: (attempt: number, reason: string) => void;
}

/**
 * POSTs via fetchImpl with a per-attempt AbortController timeout and a
 * small backoff retry on transient failures: network errors, timeouts, and
 * retryable HTTP statuses (408/429/500/502/503/504). Non-retryable HTTP
 * responses are returned as-is on the first attempt — callers keep handling
 * response.ok/status themselves, so 400/401/403 never retry.
 */
export async function fetchWithRetry(options: FetchWithRetryOptions): Promise<Response> {
  const { fetchImpl, url, init, timeoutMs, maxRetries, onAttempt, onRetry } = options;
  const maxAttempts = maxRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onAttempt?.(attempt, maxAttempts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      if (!response.ok && RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxAttempts) {
        onRetry?.(attempt, `http_${response.status}`);
        await delay(backoffMs(attempt));
        continue;
      }
      return response;
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const reason: OpenAIRequestFailureReason = isAbort ? 'timeout' : 'network';
      if (attempt < maxAttempts) {
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

  /* istanbul ignore next -- loop above always returns or throws */
  throw new OpenAIRequestError('request failed', 'network');
}

function backoffMs(attempt: number): number {
  return Math.min(250 * 2 ** (attempt - 1), 2000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
