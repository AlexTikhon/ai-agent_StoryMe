export interface ProviderExecutionOptions {
  signal?: AbortSignal | undefined;
}

/** Keeps legacy/mock call assertions stable when no cancellation signal exists. */
export function providerExecutionArgs(signal?: AbortSignal): [] | [ProviderExecutionOptions] {
  return signal ? [{ signal }] : [];
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
