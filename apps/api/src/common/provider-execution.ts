import type { ProviderCallMetrics, ProviderFailureKind } from '@book/types';

export interface ProviderExecutionOptions {
  signal?: AbortSignal | undefined;
  /** Safe numeric metrics observer supplied by the generation boundary. */
  onMetrics?: ((metrics: ProviderCallMetrics) => void) | undefined;
}

const FAILURE_KINDS = new Set<ProviderFailureKind>([
  'cancelled',
  'timeout',
  'rate_limit',
  'network',
  'authentication',
  'invalid_response',
  'provider_error',
  'unknown',
]);

function taggedFailureKind(error: unknown): ProviderFailureKind | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const direct = (error as { failureKind?: unknown }).failureKind;
  if (typeof direct === 'string' && FAILURE_KINDS.has(direct as ProviderFailureKind)) {
    return direct as ProviderFailureKind;
  }
  const details = (error as { details?: { failureKind?: unknown } }).details;
  const nested = details?.failureKind;
  return typeof nested === 'string' && FAILURE_KINDS.has(nested as ProviderFailureKind)
    ? (nested as ProviderFailureKind)
    : undefined;
}

/** Common safe classification at provider boundaries; never persists raw causes. */
export function classifyProviderFailure(error: unknown): ProviderFailureKind {
  if (isProviderCancellationError(error)) return 'cancelled';
  const tagged = taggedFailureKind(error);
  if (tagged) return tagged;

  if (error && typeof error === 'object') {
    const details = (
      error as {
        reason?: unknown;
        details?: { httpStatus?: unknown; errorCode?: unknown };
      }
    ).details;
    const reason = (error as { reason?: unknown }).reason;
    if (reason === 'timeout' || details?.errorCode === 'request_timeout') return 'timeout';
    if (reason === 'network') return 'network';
    if (details?.httpStatus === 429) return 'rate_limit';
    if (details?.httpStatus === 401 || details?.httpStatus === 403) return 'authentication';
  }
  return error instanceof Error ? 'provider_error' : 'unknown';
}

/** Stable persistence-safe message; never copies a provider/runtime payload. */
export function safeProviderFailureMessage(error: unknown): string {
  switch (classifyProviderFailure(error)) {
    case 'cancelled':
      return 'Provider operation was cancelled.';
    case 'timeout':
      return 'Provider request timed out.';
    case 'rate_limit':
      return 'Provider rate limit was reached.';
    case 'network':
      return 'Provider request failed due to a temporary network error.';
    case 'authentication':
      return 'Provider authentication failed.';
    case 'invalid_response':
      return 'Provider returned an invalid response.';
    case 'provider_error':
    case 'unknown':
      return 'Provider request failed.';
  }
}

/** Metrics must never be able to make provider work fail. */
export function reportProviderMetrics(
  options: ProviderExecutionOptions,
  metrics: ProviderCallMetrics,
): void {
  try {
    options.onMetrics?.(metrics);
  } catch {
    // Observability is best-effort and cannot change generation correctness.
  }
}

/** Typed control-flow error for cooperative pipeline cancellation. */
export class ProviderCancellationError extends Error {
  constructor(override readonly cause?: unknown) {
    super('Provider operation cancelled');
    this.name = 'ProviderCancellationError';
  }
}

export function isProviderCancellationError(error: unknown): error is ProviderCancellationError {
  return error instanceof ProviderCancellationError;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProviderCancellationError(signal.reason);
}

export function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new ProviderCancellationError(signal?.reason));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
