import type {
  GenerationFailureReason,
  ProviderCallMetrics,
  ProviderFailureKind,
} from '@book/types';

export interface ProviderExecutionOptions {
  signal?: AbortSignal | undefined;
  beforeDispatch?: (() => Promise<void>) | undefined;
  /** Safe numeric metrics observer supplied by the generation boundary. */
  onMetrics?: ((metrics: ProviderCallMetrics) => void) | undefined;
}

/** Stable, persistence-safe reasons carried across provider and worker boundaries. */
export type GenerationControlReason =
  | 'user_cancellation'
  | 'confirmed_supersession'
  | 'ownership_uncertain'
  | 'deadline'
  | 'budget_rejection'
  | 'configuration_drift'
  | 'provider_transient_failure'
  | 'refusal'
  | 'invalid_output'
  | 'storage_failure';

const GENERATION_FAILURE_REASONS = new Set<GenerationFailureReason>([
  'provider_transient_failure',
  'refusal',
  'invalid_output',
  'storage_failure',
]);

export class GenerationControlError extends Error {
  constructor(
    readonly reason: GenerationControlReason,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GenerationControlError';
  }
}

export function isGenerationControlError(error: unknown): error is GenerationControlError {
  return error instanceof GenerationControlError;
}

export function isGenerationFailureReason(reason: unknown): reason is GenerationFailureReason {
  return (
    typeof reason === 'string' && GENERATION_FAILURE_REASONS.has(reason as GenerationFailureReason)
  );
}

export function isGenerationFailureError(
  error: unknown,
): error is GenerationControlError & { readonly reason: GenerationFailureReason } {
  return isGenerationControlError(error) && isGenerationFailureReason(error.reason);
}

const FAILURE_KINDS = new Set<ProviderFailureKind>([
  'cancelled',
  'timeout',
  'rate_limit',
  'network',
  'authentication',
  'invalid_response',
  'refusal',
  'truncated',
  'schema_error',
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
  if (isGenerationFailureError(error) && error.cause !== undefined) {
    return classifyProviderFailure(error.cause);
  }

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

/** Maps provider-specific diagnostics onto the orchestration-level taxonomy. */
export function providerFailureReason(kind: ProviderFailureKind): GenerationFailureReason {
  switch (kind) {
    case 'refusal':
      return 'refusal';
    case 'truncated':
    case 'schema_error':
    case 'invalid_response':
      return 'invalid_output';
    case 'cancelled':
    case 'timeout':
    case 'rate_limit':
    case 'network':
    case 'authentication':
    case 'provider_error':
    case 'unknown':
      return 'provider_transient_failure';
  }
}

/**
 * Normalizes an arbitrary adapter/stage error once while preserving the
 * existing public diagnostic message contract. The typed reason is carried
 * independently from the message and is the value orchestration branches on.
 */
export function asGenerationFailure(
  error: unknown,
  fallback: GenerationFailureReason = 'provider_transient_failure',
): GenerationControlError & { readonly reason: GenerationFailureReason } {
  if (isGenerationFailureError(error)) return error;
  const reason =
    fallback === 'provider_transient_failure'
      ? providerFailureReason(classifyProviderFailure(error))
      : fallback;
  const message =
    reason === 'storage_failure'
      ? error instanceof Error
        ? error.message
        : 'Generated artifact storage failed.'
      : reason === 'refusal'
        ? 'Provider declined this request.'
        : reason === 'invalid_output'
          ? 'Provider returned invalid output.'
          : safeProviderFailureMessage(error);
  return new GenerationControlError(reason, message, error) as GenerationControlError & {
    readonly reason: GenerationFailureReason;
  };
}

export function generationFailureCode(reason: GenerationFailureReason): string {
  return `GENERATION_${reason.toUpperCase()}`;
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
    case 'refusal':
      return 'Provider declined this request.';
    case 'truncated':
      return 'Provider output exceeded the configured token limit.';
    case 'schema_error':
      return 'Provider output did not match the required schema.';
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
  readonly controlReason: GenerationControlReason | undefined;

  constructor(override readonly cause?: unknown) {
    super('Provider operation cancelled');
    this.name = 'ProviderCancellationError';
    this.controlReason = isGenerationControlError(cause) ? cause.reason : undefined;
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
