import { describe, expect, it, vi } from 'vitest';
import { DraftProviderError, type DraftRequest } from './provider';
import { OpenAIScenarioDraftProvider } from './openai-provider';
import { LAST_TRAM_BRIEF } from './the-last-tram';

/**
 * These tests intercept HTTP. They prove request construction and response
 * handling only — nothing about the quality of real model output.
 */

const SECRET = 'sk-test-secret-key-123';
const request = (overrides: Partial<DraftRequest> = {}): DraftRequest => ({
  kind: 'generate',
  brief: LAST_TRAM_BRIEF,
  maxOutputTokens: 4000,
  timeoutMs: 1000,
  ...overrides,
});

const completion = (message: Record<string, unknown>, finish = 'stop', usage?: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: finish, message }],
      ...(usage !== undefined && { usage }),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

const makeProvider = (fetchImpl: typeof fetch) =>
  new OpenAIScenarioDraftProvider({ apiKey: SECRET, model: 'test-model-1', fetchImpl });

async function failureKind(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DraftProviderError);
  return error as DraftProviderError;
}

describe('OpenAIScenarioDraftProvider request', () => {
  it('sends one strict structured-output request with no tools and a token cap', async () => {
    const fetchImpl = vi.fn(async () => completion({ content: '{"ok":true}' }));
    const response = await makeProvider(fetchImpl as unknown as typeof fetch).draft(request());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${SECRET}`);

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('test-model-1');
    expect(body.max_completion_tokens).toBe(4000);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('functions');
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(body.messages[1].content).toContain('<brief>');
    expect(JSON.stringify(body)).not.toContain(SECRET);

    expect(response).toEqual({ candidate: '{"ok":true}', usage: {}, httpAttempts: 1 });
  });

  it('includes only the bounded diagnostics and previous candidate in a repair request', async () => {
    const fetchImpl = vi.fn(async () => completion({ content: '{}' }));
    await makeProvider(fetchImpl as unknown as typeof fetch).draft(
      request({
        kind: 'repair',
        previous: {
          candidateText: '{"previous":1}',
          diagnostics: [
            { stage: 'definition', code: 'DEFINITION_INVALID', message: 'unknown scene' },
          ],
        },
      }),
    );
    const body = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.messages[1].content).toContain('[definition/DEFINITION_INVALID] unknown scene');
    expect(body.messages[1].content).toContain('{"previous":1}');
  });

  it('reports token usage only when the provider supplied it', async () => {
    const withUsage = await makeProvider((async () =>
      completion({ content: '{}' }, 'stop', {
        prompt_tokens: 1200,
        completion_tokens: 3400,
      })) as unknown as typeof fetch).draft(request());
    expect(withUsage.usage).toEqual({ inputTokens: 1200, outputTokens: 3400 });

    const without = await makeProvider((async () =>
      completion({ content: '{}' }, 'stop', {
        total_tokens: 'many',
      })) as unknown as typeof fetch).draft(request());
    expect(without.usage).toEqual({});
  });
});

describe('OpenAIScenarioDraftProvider: no implicit retries (one call = one attempt)', () => {
  it.each([
    [500, 'provider_error'],
    [502, 'provider_error'],
    [503, 'provider_error'],
    [408, 'provider_error'],
    [429, 'rate_limit'],
    [401, 'authentication'],
    [403, 'authentication'],
    [400, 'provider_error'],
  ])('HTTP %i fails after exactly one fetch as %s', async (status, kind) => {
    const fetchImpl = vi.fn(async () => new Response(`secret ${SECRET} body`, { status }));
    const error = await failureKind(
      makeProvider(fetchImpl as unknown as typeof fetch).draft(request()),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(error.kind).toBe(kind);
    expect(error.httpAttempts).toBe(1);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain('body');
  });

  it('does not retry a network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`connect failed for ${SECRET}`);
    });
    const error = await failureKind(
      makeProvider(fetchImpl as unknown as typeof fetch).draft(request()),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(error.kind).toBe('network');
    expect(error.message).not.toContain(SECRET);
  });

  it('does not retry a timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const error = await failureKind(
      makeProvider(fetchImpl as unknown as typeof fetch).draft(request({ timeoutMs: 25 })),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(error.kind).toBe('timeout');
    expect(error.httpAttempts).toBe(1);
  });

  it('maps external cancellation to cancelled without a second attempt', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const pending = makeProvider(fetchImpl as unknown as typeof fetch).draft(
      request({ signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 10);
    const error = await failureKind(pending);
    expect(error.kind).toBe('cancelled');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch at all when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => completion({ content: '{}' }));
    const error = await failureKind(
      makeProvider(fetchImpl as unknown as typeof fetch).draft(
        request({ signal: controller.signal }),
      ),
    );
    expect(error.kind).toBe('cancelled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('OpenAIScenarioDraftProvider response handling', () => {
  it('maps a refusal and a content filter to refusal', async () => {
    const refusal = await failureKind(
      makeProvider((async () =>
        completion({ content: null, refusal: 'no' })) as unknown as typeof fetch).draft(request()),
    );
    expect(refusal.kind).toBe('refusal');
    const filtered = await failureKind(
      makeProvider((async () =>
        completion({ content: '' }, 'content_filter')) as unknown as typeof fetch).draft(request()),
    );
    expect(filtered.kind).toBe('refusal');
  });

  it('maps finish_reason length to truncated and keeps the reported usage', async () => {
    const error = await failureKind(
      makeProvider((async () =>
        completion({ content: '{"id":' }, 'length', {
          prompt_tokens: 10,
          completion_tokens: 4000,
        })) as unknown as typeof fetch).draft(request()),
    );
    expect(error.kind).toBe('truncated');
    expect(error.usage).toEqual({ inputTokens: 10, outputTokens: 4000 });
  });

  it('rejects an envelope that is not JSON, has no content, or is oversized', async () => {
    const notJson = await failureKind(
      makeProvider((async () => new Response('<html>')) as unknown as typeof fetch).draft(
        request(),
      ),
    );
    expect(notJson.kind).toBe('invalid_response');
    const noContent = await failureKind(
      makeProvider((async () => completion({})) as unknown as typeof fetch).draft(request()),
    );
    expect(noContent.kind).toBe('invalid_response');
    const huge = await failureKind(
      makeProvider(
        (async () => new Response('x'.repeat(250_000))) as unknown as typeof fetch,
      ).draft(request()),
    );
    expect(huge.kind).toBe('invalid_response');
  });
});

describe('OpenAIScenarioDraftProvider construction', () => {
  it('has no default model and requires a credential', () => {
    expect(() => new OpenAIScenarioDraftProvider({ apiKey: SECRET, model: '' })).toThrow(
      /explicit/,
    );
    expect(() => new OpenAIScenarioDraftProvider({ apiKey: '', model: 'm' })).toThrow(/apiKey/);
    expect(() => new OpenAIScenarioDraftProvider({ apiKey: SECRET, model: 'bad model!' })).toThrow(
      /explicit/,
    );
  });
});
