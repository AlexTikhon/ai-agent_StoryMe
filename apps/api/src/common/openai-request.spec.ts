import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchWithRetry,
  OpenAIRequestError,
  readOpenAIRetryConfig,
  readOpenAIImageTimeoutConfig,
  DEFAULT_OPENAI_REQUEST_TIMEOUT_MS,
  DEFAULT_OPENAI_MAX_RETRIES,
  DEFAULT_OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
  DEFAULT_OPENAI_IMAGE_TIMEOUT_MAX_RETRIES,
  MIN_OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
  MAX_OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
} from './openai-request';

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
