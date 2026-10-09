import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { interactiveApi } from './interactive';
import { ApiError } from './client';
import { setAccessToken } from '../auth/token-store';

function mockOk(body: unknown, status = 200): Response {
  return { ok: true, status, json: async () => body } as unknown as Response;
}

function mockError(status: number, body: Record<string, unknown>): Response {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

describe('interactiveApi', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    setAccessToken('access-token-123');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('createSession POSTs exactly the creation command', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk({ sessionId: 's1' }, 201));
    const controller = new AbortController();
    const command = { scenarioId: 'warsaw-last-delivery', idempotencyKey: 'start-key-1' };

    await interactiveApi.createSession(command, controller.signal);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4000/api/interactive/sessions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(command);
    expect(init.signal).toBe(controller.signal);
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer access-token-123',
    );
  });

  it('listSessions GETs the first page with no query, and later pages with limit and cursor', async () => {
    vi.mocked(fetch).mockResolvedValue(mockOk({ sessions: [], nextCursor: null }));
    const controller = new AbortController();

    await interactiveApi.listSessions({}, controller.signal);
    await interactiveApi.listSessions({ limit: 20, cursor: 'abc_-123' });

    const calls = vi.mocked(fetch).mock.calls as Array<[string, RequestInit]>;
    expect(calls[0]![0]).toBe('http://localhost:4000/api/interactive/sessions');
    expect(calls[0]![1].method).toBeUndefined();
    expect(calls[0]![1].signal).toBe(controller.signal);
    expect(calls[1]![0]).toBe(
      'http://localhost:4000/api/interactive/sessions?limit=20&cursor=abc_-123',
    );
  });

  it('getSession GETs the session by id', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk({ sessionId: 's1' }));

    await interactiveApi.getSession('s1');

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4000/api/interactive/sessions/s1');
    expect(init.method).toBeUndefined();
  });

  it('submitChoice POSTs the exact command', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk({ sessionId: 's1' }));
    const command = { choiceId: 'c-1', expectedRevision: 3, idempotencyKey: 'key-1' };

    await interactiveApi.submitChoice('s1', command);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4000/api/interactive/sessions/s1/choices');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(command);
  });

  it('surfaces the stable API error code', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockError(409, { code: 'REVISION_CONFLICT', message: 'moved on' }),
    );

    const error = await interactiveApi
      .submitChoice('s1', { choiceId: 'c', expectedRevision: 0, idempotencyKey: 'k' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
  });
});
