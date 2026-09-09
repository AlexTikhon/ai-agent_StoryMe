import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchWithRetry,
  OpenAIRequestError,
  OpenAIResponseBodyError,
  readOpenAIRetryConfig,
  readOpenAIImageTimeoutConfig,
  DEFAULT_OPENAI_REQUEST_TIMEOUT_MS,
  DEFAULT_OPENAI_MAX_RETRIES,
  DEFAULT_OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
  DEFAULT_OPENAI_IMAGE_TIMEOUT_MAX_RETRIES,
  MIN_OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
  MAX_OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
} from './openai-request';
import { ProviderCancellationError } from './provider-execution';

function makeAbortableFetch() {
  return vi.fn((_url: string, init: RequestInit) => {
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  });
}

function okResponse(): Response {
  return { ok: true, status: 200 } as Response;
}

function statusResponse(status: number): Response {
  return { ok: false, status } as Response;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('readOpenAIRetryConfig', () => {
  it('falls back to safe defaults when env vars are missing', () => {
    const config = readOpenAIRetryConfig({} as NodeJS.ProcessEnv);
    expect(config).toEqual({
      timeoutMs: DEFAULT_OPENAI_REQUEST_TIMEOUT_MS,
      maxRetries: DEFAULT_OPENAI_MAX_RETRIES,
    });
  });

  it('reads valid env vars', () => {
    const config = readOpenAIRetryConfig({
      OPENAI_REQUEST_TIMEOUT_MS: '15000',
      OPENAI_MAX_RETRIES: '4',
    } as unknown as NodeJS.ProcessEnv);
    expect(config).toEqual({ timeoutMs: 15000, maxRetries: 4 });
  });

  it('falls back to defaults for malformed values', () => {
    const config = readOpenAIRetryConfig({
      OPENAI_REQUEST_TIMEOUT_MS: 'not-a-number',
      OPENAI_MAX_RETRIES: '-1',
    } as unknown as NodeJS.ProcessEnv);
    expect(config).toEqual({
      timeoutMs: DEFAULT_OPENAI_REQUEST_TIMEOUT_MS,
      maxRetries: DEFAULT_OPENAI_MAX_RETRIES,
    });
  });
});

describe('readOpenAIImageTimeoutConfig', () => {
  it('falls back to safe defaults when env vars are missing', () => {
    const config = readOpenAIImageTimeoutConfig({} as NodeJS.ProcessEnv);
    expect(config).toEqual({
      timeoutMs: DEFAULT_OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
      timeoutMaxRetries: DEFAULT_OPENAI_IMAGE_TIMEOUT_MAX_RETRIES,
    });
  });

  it('reads valid env vars', () => {
    const config = readOpenAIImageTimeoutConfig({
      OPENAI_IMAGE_REQUEST_TIMEOUT_MS: '120000',
      OPENAI_IMAGE_TIMEOUT_MAX_RETRIES: '3',
    } as unknown as NodeJS.ProcessEnv);
    expect(config).toEqual({ timeoutMs: 120000, timeoutMaxRetries: 3 });
  });

  it('accepts the exact minimum and maximum bounds', () => {
    expect(
      readOpenAIImageTimeoutConfig({
        OPENAI_IMAGE_REQUEST_TIMEOUT_MS: String(MIN_OPENAI_IMAGE_REQUEST_TIMEOUT_MS),
      } as unknown as NodeJS.ProcessEnv).timeoutMs,
    ).toBe(MIN_OPENAI_IMAGE_REQUEST_TIMEOUT_MS);
    expect(
      readOpenAIImageTimeoutConfig({
        OPENAI_IMAGE_REQUEST_TIMEOUT_MS: String(MAX_OPENAI_IMAGE_REQUEST_TIMEOUT_MS),
      } as unknown as NodeJS.ProcessEnv).timeoutMs,
    ).toBe(MAX_OPENAI_IMAGE_REQUEST_TIMEOUT_MS);
  });

  it('falls back to the default timeout when below the minimum bound', () => {
    const config = readOpenAIImageTimeoutConfig({
      OPENAI_IMAGE_REQUEST_TIMEOUT_MS: '1000',
    } as unknown as NodeJS.ProcessEnv);
    expect(config.timeoutMs).toBe(DEFAULT_OPENAI_IMAGE_REQUEST_TIMEOUT_MS);
  });

  it('falls back to the default timeout when above the maximum bound', () => {
    const config = readOpenAIImageTimeoutConfig({
      OPENAI_IMAGE_REQUEST_TIMEOUT_MS: '999999999',
    } as unknown as NodeJS.ProcessEnv);
    expect(config.timeoutMs).toBe(DEFAULT_OPENAI_IMAGE_REQUEST_TIMEOUT_MS);
  });

  it('falls back to defaults for malformed values', () => {
    const config = readOpenAIImageTimeoutConfig({
      OPENAI_IMAGE_REQUEST_TIMEOUT_MS: 'not-a-number',
      OPENAI_IMAGE_TIMEOUT_MAX_RETRIES: '-1',
    } as unknown as NodeJS.ProcessEnv);
    expect(config).toEqual({
      timeoutMs: DEFAULT_OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
      timeoutMaxRetries: DEFAULT_OPENAI_IMAGE_TIMEOUT_MAX_RETRIES,
    });
  });
});

describe('fetchWithRetry', () => {
  it('rejects an external abort before dispatch without calling fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();

    await expect(
      fetchWithRetry({
        fetchImpl,
        url: 'https://example.test',
        init: {},
        timeoutMs: 1000,
        maxRetries: 2,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ProviderCancellationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('external abort cancels an active fetch and never becomes a timeout', async () => {
    const controller = new AbortController();
    const fetchImpl = makeAbortableFetch();
    const promise = fetchWithRetry({
      fetchImpl,
      url: 'https://example.test',
      init: {},
      timeoutMs: 10_000,
      maxRetries: 2,
      signal: controller.signal,
    });

    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(ProviderCancellationError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('external abort interrupts retry backoff and prevents another attempt', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValue(statusResponse(500));
    const promise = fetchWithRetry({
      fetchImpl,
      url: 'https://example.test',
      init: {},
      timeoutMs: 10_000,
      maxRetries: 2,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(ProviderCancellationError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the attempt timeout active after headers arrive and bounds stalled-body retries', async () => {
    vi.useFakeTimers();
    const cancelBody = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockImplementation(async () => {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: { cancel: cancelBody },
        json: () => new Promise<never>(() => undefined),
      } as unknown as Response;
    });

    const promise = fetchWithRetry({
      fetchImpl,
      url: 'https://example.test',
      init: {},
      timeoutMs: 50,
      maxRetries: 5,
      timeoutMaxRetries: 1,
      consumeResponse: (response) => response.json(),
    });
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'OpenAIRequestError',
      reason: 'timeout',
    });

    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(cancelBody).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels during response-body reading and never dispatches another request', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeExternalListener = vi.spyOn(controller.signal, 'removeEventListener');
    const cancelBody = vi.fn().mockResolvedValue(undefined);
    const json = vi.fn(() => new Promise<never>(() => undefined));
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { cancel: cancelBody },
      json,
    } as unknown as Response);

    const promise = fetchWithRetry({
      fetchImpl,
      url: 'https://example.test',
      init: {},
      timeoutMs: 10_000,
      maxRetries: 2,
      signal: controller.signal,
      consumeResponse: (response) => response.json(),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(json).toHaveBeenCalledTimes(1);
    controller.abort('cancelled by test');

    await expect(promise).rejects.toBeInstanceOf(ProviderCancellationError);
    await vi.runAllTicks();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(removeExternalListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns successfully consumed JSON and releases the attempt timer', async () => {
    vi.useFakeTimers();
    const payload = { choices: [{ message: { content: '{}' } }] };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'x-request-id': 'req-1' }),
      json: async () => payload,
    } as Response);

    const response = await fetchWithRetry({
      fetchImpl,
      url: 'https://example.test',
      init: {},
      timeoutMs: 1000,
      maxRetries: 2,
      consumeResponse: (attemptResponse) => attemptResponse.json(),
    });

    expect(response.body).toEqual(payload);
    expect(response.headers.get('x-request-id')).toBe('req-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry malformed JSON and identifies it as a response-body failure', async () => {
    const parseError = new SyntaxError('malformed JSON');
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => Promise.reject(parseError),
    } as Response);

    const promise = fetchWithRetry({
      fetchImpl,
      url: 'https://example.test',
      init: {},
      timeoutMs: 1000,
      maxRetries: 2,
      consumeResponse: (response) => response.json(),
    });

    await expect(promise).rejects.toMatchObject({
      name: 'OpenAIResponseBodyError',
      cause: parseError,
      httpStatus: 200,
    } satisfies Partial<OpenAIResponseBodyError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns the response on the first successful attempt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const response = await fetchWithRetry({
      fetchImpl,
      url: 'https://example.test',
      init: {},
      timeoutMs: 1000,
      maxRetries: 2,
    });
    expect(response.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-retryable HTTP statuses (e.g. 401)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(statusResponse(401));
    const response = await fetchWithRetry({
      fetchImpl,
      url: 'https://example.test',
      init: {},
      timeoutMs: 1000,
      maxRetries: 2,
    });
    expect(response.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 400 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(statusResponse(400));
    const response = await fetchWithRetry({
      fetchImpl,
      url: 'https://example.test',
      init: {},
      timeoutMs: 1000,
      maxRetries: 2,
    });
    expect(response.status).toBe(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on HTTP 429 then returns the eventual success', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(429))
      .mockResolvedValueOnce(okResponse());

    const promise = fetchWithRetry({
      fetchImpl,
      url: 'https://example.test',
      init: {},
      timeoutMs: 1000,
      maxRetries: 1,
    });
    await vi.advanceTimersByTimeAsync(5000);
    const response = await promise;

    expect(response.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries on HTTP 500 then returns the eventual success', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(500))
      .mockResolvedValueOnce(okResponse());

    const promise = fetchWithRetry({
      fetchImpl,
      url: 'https://example.test',
      init: {},
      timeoutMs: 1000,
      maxRetries: 1,
    });
    await vi.advanceTimersByTimeAsync(5000);
    const response = await promise;

    expect(response.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('cancels the discarded response body before retrying an HTTP status', async () => {
    vi.useFakeTimers();
    const cancelBody = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        body: { cancel: cancelBody },
      } as unknown as Response)
      .mockResolvedValueOnce(okResponse());

    const promise = fetchWithRetry({
      fetchImpl,
      url: 'https://example.test',
      init: {},
      timeoutMs: 1000,
      maxRetries: 1,
    });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toMatchObject({ ok: true, status: 200 });

    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(cancelBody.mock.invocationCallOrder[0]).toBeLessThan(
      fetchImpl.mock.invocationCallOrder[1]!,
    );
  });

  it('stops retrying once maxRetries is exhausted and returns the last failing response', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(statusResponse(503));

    const promise = fetchWithRetry({
      fetchImpl,
      url: 'https://example.test',
      init: {},
      timeoutMs: 1000,
      maxRetries: 2,
    });
    await vi.advanceTimersByTimeAsync(10000);
    const response = await promise;

    expect(response.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('throws OpenAIRequestError with reason "timeout" when every attempt times out', async () => {
    vi.useFakeTimers();
    const fetchImpl = makeAbortableFetch();

    const promise = fetchWithRetry({
      fetchImpl,
      url: 'https://example.test',
      init: {},
      timeoutMs: 50,
      maxRetries: 0,
    });
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'OpenAIRequestError',
      reason: 'timeout',
    });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it('throws OpenAIRequestError with reason "network" when fetch rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(
      fetchWithRetry({
        fetchImpl,
        url: 'https://example.test',
        init: {},
        timeoutMs: 1000,
        maxRetries: 0,
      }),
    ).rejects.toMatchObject({ name: 'OpenAIRequestError', reason: 'network' });
  });

  it('retries network errors up to maxRetries then throws', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));

    const promise = fetchWithRetry({
      fetchImpl,
      url: 'https://example.test',
      init: {},
      timeoutMs: 1000,
      maxRetries: 2,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(OpenAIRequestError);
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('defaults timeoutMaxRetries to maxRetries when omitted (unchanged behavior)', async () => {
    vi.useFakeTimers();
    const fetchImpl = makeAbortableFetch();

    const promise = fetchWithRetry({
      fetchImpl,
      url: 'https://example.test',
      init: {},
      timeoutMs: 50,
      maxRetries: 2,
    });
    const assertion = expect(promise).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;

    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 initial + 2 retries, matching maxRetries
  });

  it('uses an independent timeoutMaxRetries budget for AbortError, separate from maxRetries', async () => {
    vi.useFakeTimers();
    const fetchImpl = makeAbortableFetch();

    const promise = fetchWithRetry({
      fetchImpl,
      url: 'https://example.test',
      init: {},
      timeoutMs: 50,
      maxRetries: 5,
      timeoutMaxRetries: 1,
    });
    const assertion = expect(promise).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;

    // Bounded by timeoutMaxRetries=1, not the much larger maxRetries=5.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a timeout at all when timeoutMaxRetries is 0, even with a positive maxRetries', async () => {
    vi.useFakeTimers();
    const fetchImpl = makeAbortableFetch();

    const promise = fetchWithRetry({
      fetchImpl,
      url: 'https://example.test',
      init: {},
      timeoutMs: 50,
      maxRetries: 3,
      timeoutMaxRetries: 0,
    });
    const assertion = expect(promise).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps network-error retries at maxRetries even when timeoutMaxRetries is smaller', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));

    const promise = fetchWithRetry({
      fetchImpl,
      url: 'https://example.test',
      init: {},
      timeoutMs: 1000,
      maxRetries: 2,
      timeoutMaxRetries: 0,
    });
    const assertion = expect(promise).rejects.toMatchObject({ reason: 'network' });
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;

    expect(fetchImpl).toHaveBeenCalledTimes(3); // network retries unaffected by timeoutMaxRetries
  });
});
