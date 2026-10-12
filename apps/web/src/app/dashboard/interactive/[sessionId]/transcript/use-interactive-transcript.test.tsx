import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { InteractiveTranscriptDto } from '@book/types';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { advanceSessionEpoch } from '@/lib/auth/token-store';
import { SESSION_ID, deferred, makeTranscriptPage } from '../../interactive-test-fixtures';
import {
  TRANSCRIPT_DEADLINE_MS,
  TRANSCRIPT_PAGE_SIZE,
  useInteractiveTranscript,
} from './use-interactive-transcript';

vi.mock('@/lib/api/interactive', () => ({
  interactiveApi: {
    getTranscript: vi.fn(),
    createSession: vi.fn(),
    submitChoice: vi.fn(),
    getSession: vi.fn(),
  },
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: vi.fn() }));

const OTHER_SESSION_ID = '9b2f1c52-7a41-4c7e-8a55-1f0d9d0c7b10';

const getTranscript = vi.mocked(interactiveApi.getTranscript);
const createSession = vi.mocked(interactiveApi.createSession);
const submitChoice = vi.mocked(interactiveApi.submitChoice);

let auth: { status: string; user: { id: string } | null };

function apiError(status: number, code: string): ApiError {
  return new ApiError(status, code, code);
}

/** Pages of a story completed at revision 6, three steps each: 0-2, 3-5, 6. */
const page1 = (sessionId = SESSION_ID) => makeTranscriptPage(0, 2, 6, { sessionId });
const page2 = (sessionId = SESSION_ID) => makeTranscriptPage(3, 5, 6, { sessionId });
const page3 = (sessionId = SESSION_ID) => makeTranscriptPage(6, 6, 6, { sessionId });

async function mountFirstPage(sessionId = SESSION_ID) {
  getTranscript.mockResolvedValueOnce(page1(sessionId));
  const hook = renderHook(({ id }) => useInteractiveTranscript(id), {
    initialProps: { id: sessionId },
  });
  await waitFor(() => expect(hook.result.current.phase).toBe('ready'));
  return hook;
}

const revisions = (chapters: { revision: number }[]) => chapters.map((c) => c.revision);

beforeEach(() => {
  auth = { status: 'authed', user: { id: 'user-1' } };
  vi.mocked(useAuth).mockImplementation(() => auth as unknown as ReturnType<typeof useAuth>);
  getTranscript.mockReset();
  createSession.mockReset();
  submitChoice.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useInteractiveTranscript — pagination', () => {
  it('requests only the first page, three steps, and never creates or chooses anything', async () => {
    const { result } = await mountFirstPage();

    expect(getTranscript).toHaveBeenCalledTimes(1);
    expect(getTranscript).toHaveBeenCalledWith(
      SESSION_ID,
      { limit: TRANSCRIPT_PAGE_SIZE, cursor: null },
      expect.any(AbortSignal),
    );
    expect(TRANSCRIPT_PAGE_SIZE).toBe(3);
    expect(revisions(result.current.chapters)).toEqual([0, 1, 2]);
    expect(result.current.complete).toBe(false);
    expect(createSession).not.toHaveBeenCalled();
    expect(submitChoice).not.toHaveBeenCalled();
  });

  it('loads the remaining pages only on request, with the previous cursor, in order', async () => {
    const { result } = await mountFirstPage();
    // Idle: nothing more is requested on its own.
    await act(async () => {});
    expect(getTranscript).toHaveBeenCalledTimes(1);

    getTranscript.mockResolvedValueOnce(page2());
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.chapters).toHaveLength(6));
    expect(getTranscript.mock.calls[1]![1]).toEqual({ limit: 3, cursor: 'cursor-3' });
    expect(result.current.complete).toBe(false);

    getTranscript.mockResolvedValueOnce(page3());
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(getTranscript.mock.calls[2]![1]).toEqual({ limit: 3, cursor: 'cursor-6' });
    expect(revisions(result.current.chapters)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(result.current.chapters.at(-1)?.ending?.title).toBe('A Quiet Delivery');

    // Finished: further calls are no-ops.
    act(() => result.current.loadNext());
    expect(getTranscript).toHaveBeenCalledTimes(3);
  });

  it('exposes the identity of the pinned scenario version for the title', async () => {
    const { result } = await mountFirstPage();
    expect(result.current.identity).toEqual({
      sessionId: SESSION_ID,
      scenarioId: 'warsaw-last-delivery',
      scenarioVersion: 1,
      completedRevision: 6,
    });
  });

  it('sends one request for duplicate clicks while a page is loading', async () => {
    const { result } = await mountFirstPage();
    const gate = deferred<InteractiveTranscriptDto>();
    getTranscript.mockReturnValueOnce(gate.promise);

    act(() => {
      result.current.loadNext();
      result.current.loadNext();
      result.current.loadNext();
    });
    expect(result.current.loadingMore).toBe(true);
    expect(getTranscript).toHaveBeenCalledTimes(2);

    await act(async () => gate.resolve(page2()));
    expect(revisions(result.current.chapters)).toEqual([0, 1, 2, 3, 4, 5]); // appended once
    expect(result.current.loadingMore).toBe(false);
  });
});

describe('useInteractiveTranscript — failures', () => {
  it('retries the first page after an initial failure', async () => {
    getTranscript.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useInteractiveTranscript(SESSION_ID));
    await waitFor(() => expect(result.current.phase).toBe('error'));
    expect(result.current.failure).toBe('failed');
    expect(result.current.chapters).toEqual([]);
    expect(getTranscript).toHaveBeenCalledTimes(1); // no automatic retry

    getTranscript.mockResolvedValueOnce(page1());
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(getTranscript.mock.calls[1]![1]).toEqual({ limit: 3, cursor: null });
    expect(revisions(result.current.chapters)).toEqual([0, 1, 2]);
    expect(result.current.failure).toBeNull();
  });

  it('keeps loaded chapters after a later failure and retries the exact failed cursor', async () => {
    const { result } = await mountFirstPage();

    getTranscript.mockRejectedValueOnce(apiError(503, 'SERVICE_UNAVAILABLE'));
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.failure).toBe('failed'));
    expect(result.current.phase).toBe('ready');
    expect(revisions(result.current.chapters)).toEqual([0, 1, 2]);
    expect(result.current.complete).toBe(false); // partial history is never complete
    expect(result.current.loadingMore).toBe(false);

    getTranscript.mockResolvedValueOnce(page2());
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.chapters).toHaveLength(6));
    expect(getTranscript.mock.calls[1]![1]).toEqual({ limit: 3, cursor: 'cursor-3' });
    expect(getTranscript.mock.calls[2]![1]).toEqual({ limit: 3, cursor: 'cursor-3' });
    expect(result.current.failure).toBeNull();
  });

  it.each([
    ['initial', true],
    ['later', false],
  ])('reports a %s rate limit as rate-limited', async (_label, initial) => {
    if (initial) {
      getTranscript.mockRejectedValueOnce(apiError(429, 'RATE_LIMITED'));
      const { result } = renderHook(() => useInteractiveTranscript(SESSION_ID));
      await waitFor(() => expect(result.current.failure).toBe('rate-limited'));
      expect(result.current.phase).toBe('error');
    } else {
      const { result } = await mountFirstPage();
      getTranscript.mockRejectedValueOnce(apiError(429, 'RATE_LIMITED'));
      act(() => result.current.loadNext());
      await waitFor(() => expect(result.current.failure).toBe('rate-limited'));
      expect(revisions(result.current.chapters)).toEqual([0, 1, 2]);
    }
  });

  it.each([
    ['missing', 404],
    ['foreign', 404],
  ])('shows the same unavailable state for a %s session', async (_label, status) => {
    getTranscript.mockRejectedValueOnce(apiError(status, 'SESSION_NOT_FOUND'));
    const { result } = renderHook(() => useInteractiveTranscript(SESSION_ID));
    await waitFor(() => expect(result.current.phase).toBe('unavailable'));
    expect(result.current.chapters).toEqual([]);
  });

  it('reports an unfinished story as not completed', async () => {
    getTranscript.mockRejectedValueOnce(apiError(409, 'SESSION_NOT_COMPLETED'));
    const { result } = renderHook(() => useInteractiveTranscript(SESSION_ID));
    await waitFor(() => expect(result.current.phase).toBe('not-completed'));
    expect(result.current.chapters).toEqual([]);
  });

  it('reports an authentication failure for the shared auth layer to handle', async () => {
    getTranscript.mockRejectedValueOnce(apiError(401, 'UNAUTHORIZED'));
    const { result } = renderHook(() => useInteractiveTranscript(SESSION_ID));
    await waitFor(() => expect(result.current.phase).toBe('auth-required'));
    expect(result.current.chapters).toEqual([]);
  });

  it('bounds a hung request with a local deadline and keeps what is loaded', async () => {
    const { result } = await mountFirstPage();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    getTranscript.mockImplementationOnce(
      (_id, _params, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    act(() => result.current.loadNext());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_DEADLINE_MS);
    });

    expect(result.current.failure).toBe('failed');
    expect(revisions(result.current.chapters)).toEqual([0, 1, 2]);
    expect(result.current.loadingMore).toBe(false);
  });
});

describe('useInteractiveTranscript — inconsistent responses', () => {
  it('rejects an inconsistent later page visibly and appends nothing', async () => {
    const { result } = await mountFirstPage();
    // Skips revision 3.
    getTranscript.mockResolvedValueOnce(makeTranscriptPage(4, 6, 6));
    act(() => result.current.loadNext());

    await waitFor(() => expect(result.current.failure).toBe('inconsistent'));
    expect(revisions(result.current.chapters)).toEqual([0, 1, 2]);
    expect(result.current.complete).toBe(false);

    // The same cursor can be retried and then succeeds.
    getTranscript.mockResolvedValueOnce(page2());
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.chapters).toHaveLength(6));
    expect(getTranscript.mock.calls[2]![1]).toEqual({ limit: 3, cursor: 'cursor-3' });
  });

  it.each<[string, Partial<InteractiveTranscriptDto>]>([
    ['another session', { sessionId: OTHER_SESSION_ID }],
    ['another scenario version', { scenarioVersion: 2 }],
    ['another completed revision', { completedRevision: 7 }],
    ['a repeated cursor', { nextCursor: 'cursor-3' }],
  ])('rejects a later page with %s', async (_label, overrides) => {
    const { result } = await mountFirstPage();
    getTranscript.mockResolvedValueOnce({ ...page2(), ...overrides });
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.failure).toBe('inconsistent'));
    expect(revisions(result.current.chapters)).toEqual([0, 1, 2]);
  });

  it('rejects a duplicate page instead of appending it twice', async () => {
    const { result } = await mountFirstPage();
    getTranscript.mockResolvedValueOnce({ ...page1(), nextCursor: 'cursor-9' });
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.failure).toBe('inconsistent'));
    expect(revisions(result.current.chapters)).toEqual([0, 1, 2]);
  });

  it('shows an inconsistent first page as an error, with nothing displayed', async () => {
    getTranscript.mockResolvedValueOnce(page2()); // starts at revision 3
    const { result } = renderHook(() => useInteractiveTranscript(SESSION_ID));
    await waitFor(() => expect(result.current.phase).toBe('error'));
    expect(result.current.failure).toBe('inconsistent');
    expect(result.current.chapters).toEqual([]);
  });

  it('detects a cursor loop across pages', async () => {
    // A story completed at revision 9: pages 0-2, 3-5, 6-8, 9.
    getTranscript.mockResolvedValueOnce(makeTranscriptPage(0, 2, 9));
    const { result } = renderHook(() => useInteractiveTranscript(SESSION_ID));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    getTranscript.mockResolvedValueOnce(makeTranscriptPage(3, 5, 9));
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.chapters).toHaveLength(6));

    // The next page points back at a cursor that was already used.
    getTranscript.mockResolvedValueOnce(makeTranscriptPage(6, 8, 9, { nextCursor: 'cursor-3' }));
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.failure).toBe('inconsistent'));
    expect(result.current.chapters).toHaveLength(6);
  });
});

describe('useInteractiveTranscript — scope and stale work', () => {
  it('clears old chapters synchronously when the session changes and ignores the old answer', async () => {
    const { result, rerender } = await mountFirstPage();
    const gate = deferred<InteractiveTranscriptDto>();
    getTranscript.mockReturnValueOnce(gate.promise);
    act(() => result.current.loadNext());
    const oldSignal = getTranscript.mock.calls[1]![2]!;

    const second = deferred<InteractiveTranscriptDto>();
    getTranscript.mockReturnValueOnce(second.promise);
    rerender({ id: OTHER_SESSION_ID });
    // Same render pass: nothing of the previous session is visible.
    expect(result.current.chapters).toEqual([]);
    expect(result.current.phase).toBe('loading');
    expect(oldSignal.aborted).toBe(true);

    await act(async () => gate.resolve(page2()));
    expect(result.current.chapters).toEqual([]);

    await act(async () => second.resolve(page1(OTHER_SESSION_ID)));
    expect(revisions(result.current.chapters)).toEqual([0, 1, 2]);
    expect(result.current.identity?.sessionId).toBe(OTHER_SESSION_ID);
    expect(getTranscript.mock.calls[2]![0]).toBe(OTHER_SESSION_ID);
  });

  it('ignores a stale failure of the previous session', async () => {
    const { result, rerender } = await mountFirstPage();
    const gate = deferred<InteractiveTranscriptDto>();
    getTranscript.mockReturnValueOnce(gate.promise);
    act(() => result.current.loadNext());
    getTranscript.mockResolvedValueOnce(page1(OTHER_SESSION_ID));
    rerender({ id: OTHER_SESSION_ID });
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    await act(async () => gate.reject(apiError(404, 'SESSION_NOT_FOUND')));
    expect(result.current.phase).toBe('ready');
    expect(result.current.failure).toBeNull();
    expect(revisions(result.current.chapters)).toEqual([0, 1, 2]);
  });

  it('a stale request finishing does not release the new scope’s single-flight guard', async () => {
    const { result, rerender } = await mountFirstPage();
    const oldGate = deferred<InteractiveTranscriptDto>();
    getTranscript.mockReturnValueOnce(oldGate.promise);
    act(() => result.current.loadNext());

    const newFirst = deferred<InteractiveTranscriptDto>();
    getTranscript.mockReturnValueOnce(newFirst.promise);
    rerender({ id: OTHER_SESSION_ID });

    await act(async () => oldGate.reject(new TypeError('late')));
    // The new scope's first page is still in flight: another click must not duplicate it.
    act(() => result.current.loadNext());
    expect(getTranscript).toHaveBeenCalledTimes(3);
    await act(async () => newFirst.resolve(page1(OTHER_SESSION_ID)));
    expect(result.current.phase).toBe('ready');
  });

  it('drops an answer that arrives after the auth session epoch changed', async () => {
    const { result } = await mountFirstPage();
    const gate = deferred<InteractiveTranscriptDto>();
    getTranscript.mockReturnValueOnce(gate.promise);
    act(() => result.current.loadNext());

    act(() => {
      advanceSessionEpoch();
    });
    await act(async () => gate.resolve(page2()));

    expect(revisions(result.current.chapters)).toEqual([0, 1, 2]);
  });

  it('survives logout followed by login as the same account without leaking old answers', async () => {
    const { result, rerender } = await mountFirstPage();
    const gate = deferred<InteractiveTranscriptDto>();
    getTranscript.mockReturnValueOnce(gate.promise);
    act(() => result.current.loadNext());

    // Logout, then login as the very same user id.
    act(() => {
      advanceSessionEpoch();
    });
    auth = { status: 'anon', user: null };
    rerender({ id: SESSION_ID });
    expect(result.current.chapters).toEqual([]);
    expect(result.current.phase).toBe('loading');

    act(() => {
      advanceSessionEpoch();
    });
    auth = { status: 'authed', user: { id: 'user-1' } };
    getTranscript.mockResolvedValueOnce(page1());
    rerender({ id: SESSION_ID });
    expect(result.current.chapters).toEqual([]); // fresh scope: nothing carried over
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    // The old scope's late answer must not append page 2 to the new login's history.
    await act(async () => gate.resolve(page2()));
    expect(revisions(result.current.chapters)).toEqual([0, 1, 2]);
    expect(getTranscript.mock.calls[2]![1]).toEqual({ limit: 3, cursor: null });
  });

  it('clears the chapters when another account signs in on the same page', async () => {
    const { result, rerender } = await mountFirstPage();
    getTranscript.mockReturnValueOnce(new Promise(() => {}));
    auth = { status: 'authed', user: { id: 'user-2' } };
    rerender({ id: SESSION_ID });
    expect(result.current.chapters).toEqual([]);
    expect(result.current.phase).toBe('loading');
  });

  it('aborts the request on unmount', async () => {
    const { result, unmount } = await mountFirstPage();
    getTranscript.mockReturnValueOnce(new Promise(() => {}));
    act(() => result.current.loadNext());
    const signal = getTranscript.mock.calls[1]![2]!;
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it('requests nothing while signed out', () => {
    auth = { status: 'anon', user: null };
    renderHook(() => useInteractiveTranscript(SESSION_ID));
    expect(getTranscript).not.toHaveBeenCalled();
  });
});
