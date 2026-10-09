import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { InteractiveSessionViewDto } from '@book/types';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { advanceSessionEpoch } from '@/lib/auth/token-store';
import { SESSION_ID, deferred, makeView } from '../interactive-test-fixtures';
import {
  FOCUS_REFRESH_MIN_AGE_MS,
  REQUEST_DEADLINE_MS,
  useInteractiveReader,
} from './use-interactive-reader';

vi.mock('@/lib/api/interactive', () => ({
  interactiveApi: { createSession: vi.fn(), getSession: vi.fn(), submitChoice: vi.fn() },
}));

vi.mock('@/lib/auth/auth-context', () => ({ useAuth: vi.fn() }));

const OTHER_SESSION_ID = '9b2f1c52-7a41-4c7e-8a55-1f0d9d0c7b10';

const getSession = vi.mocked(interactiveApi.getSession);
const submitChoice = vi.mocked(interactiveApi.submitChoice);
const createSession = vi.mocked(interactiveApi.createSession);

let auth: { status: string; user: { id: string } | null };

function apiError(status: number, code: string): ApiError {
  return new ApiError(status, code, code);
}

async function mount(revision = 0, sessionId = SESSION_ID) {
  getSession.mockResolvedValueOnce(makeView(revision, { sessionId }));
  const hook = renderHook(({ id }) => useInteractiveReader(id), {
    initialProps: { id: sessionId },
  });
  await waitFor(() => expect(hook.result.current.phase).toBe('ready'));
  return hook;
}

/** Moves the clock past the focus-refresh freshness window (only Date is faked). */
function ageDisplayedState() {
  vi.setSystemTime(Date.now() + FOCUS_REFRESH_MIN_AGE_MS + 1_000);
}

function focusTab() {
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  auth = { status: 'authed', user: { id: 'user-1' } };
  vi.mocked(useAuth).mockImplementation(() => auth as unknown as ReturnType<typeof useAuth>);
  getSession.mockReset();
  submitChoice.mockReset();
  createSession.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useInteractiveReader — loading', () => {
  it('fetches the existing session and never creates one', async () => {
    const { result } = await mount(2);

    expect(getSession).toHaveBeenCalledWith(SESSION_ID, expect.any(AbortSignal));
    expect(createSession).not.toHaveBeenCalled();
    expect(result.current.view?.revision).toBe(2);
    expect(result.current.choicesEnabled).toBe(true);
  });

  it.each([
    ['missing', 404],
    ['foreign', 404],
  ])('shows the same unavailable state for a %s session', async (_label, status) => {
    getSession.mockRejectedValueOnce(apiError(status, 'SESSION_NOT_FOUND'));
    const { result } = renderHook(() => useInteractiveReader(SESSION_ID));

    await waitFor(() => expect(result.current.phase).toBe('unavailable'));
    expect(result.current.view).toBeNull();
    expect(result.current.choicesEnabled).toBe(false);
  });

  it('offers a retry after a load failure', async () => {
    getSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useInteractiveReader(SESSION_ID));
    await waitFor(() => expect(result.current.phase).toBe('load-error'));

    getSession.mockResolvedValueOnce(makeView(0));
    act(() => result.current.retryLoad());
    await waitFor(() => expect(result.current.phase).toBe('ready'));
  });

  it('hands a definitive 401 to the existing auth flow', async () => {
    getSession.mockRejectedValueOnce(apiError(401, 'UNAUTHORIZED'));
    const { result } = renderHook(() => useInteractiveReader(SESSION_ID));

    await waitFor(() => expect(result.current.phase).toBe('auth-required'));
  });

  it('bounds a hung load with a local deadline', async () => {
    vi.useRealTimers(); // re-faking an active fake clock keeps its old config
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    getSession.mockImplementation(
      (_id, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const { result } = renderHook(() => useInteractiveReader(SESSION_ID));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);
    });

    expect(result.current.phase).toBe('load-error');
  });
});

describe('useInteractiveReader — choosing', () => {
  it('sends the displayed revision with one key and does not advance optimistically', async () => {
    const { result } = await mount(3);
    const gate = deferred<InteractiveSessionViewDto>();
    submitChoice.mockReturnValueOnce(gate.promise);

    act(() => result.current.submitChoice('c-a'));

    expect(submitChoice).toHaveBeenCalledTimes(1);
    const [sessionId, command] = submitChoice.mock.calls[0]!;
    expect(sessionId).toBe(SESSION_ID);
    expect(command).toEqual({
      choiceId: 'c-a',
      expectedRevision: 3,
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    // Nothing moves until the server answers.
    expect(result.current.view?.revision).toBe(3);
    expect(result.current.view?.scene.id).toBe('scene-3');
    expect(result.current.choicesEnabled).toBe(false);

    await act(async () => gate.resolve(makeView(4)));
    expect(result.current.view?.revision).toBe(4);
    expect(result.current.choicesEnabled).toBe(true);
  });

  it('is single-flight even for synchronous repeat calls', async () => {
    const { result } = await mount(0);
    submitChoice.mockReturnValue(deferred<InteractiveSessionViewDto>().promise);

    act(() => {
      result.current.submitChoice('c-a');
      result.current.submitChoice('c-a');
      result.current.submitChoice('c-other');
    });

    expect(submitChoice).toHaveBeenCalledTimes(1);
  });

  it('ignores choices the server did not offer', async () => {
    const { result } = await mount(0);

    act(() => result.current.submitChoice('c-locked'));

    expect(submitChoice).not.toHaveBeenCalled();
  });

  it('retries an ambiguous failure with the identical command and confirms before enabling', async () => {
    const { result } = await mount(0);
    submitChoice.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    act(() => result.current.submitChoice('c-a'));
    await waitFor(() => expect(result.current.command?.phase).toBe('retryable'));
    expect(result.current.choicesEnabled).toBe(false);

    const refreshGate = deferred<InteractiveSessionViewDto>();
    submitChoice.mockResolvedValueOnce(makeView(1));
    getSession.mockReturnValueOnce(refreshGate.promise);
    act(() => result.current.retryCommand());

    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(2));
    expect(submitChoice).toHaveBeenCalledTimes(2);
    expect(submitChoice.mock.calls[1]![1]).toEqual(submitChoice.mock.calls[0]![1]);
    expect(submitChoice.mock.calls[1]![1].idempotencyKey).toBe(
      submitChoice.mock.calls[0]![1].idempotencyKey,
    );
    expect(result.current.choicesEnabled).toBe(false);

    await act(async () => refreshGate.resolve(makeView(1)));
    await waitFor(() => expect(result.current.choicesEnabled).toBe(true));
    expect(result.current.view?.revision).toBe(1);
  });

  it('keeps choices blocked, and retains known state, when the recovery refresh fails', async () => {
    const { result } = await mount(0);
    submitChoice.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    act(() => result.current.submitChoice('c-a'));
    await waitFor(() => expect(result.current.command?.phase).toBe('retryable'));

    submitChoice.mockResolvedValueOnce(makeView(1));
    getSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    act(() => result.current.retryCommand());
    await waitFor(() => expect(result.current.command?.phase).toBe('confirming'));

    // The saved response is not presented as confirmed current state.
    expect(result.current.view?.revision).toBe(0);
    expect(result.current.choicesEnabled).toBe(false);

    getSession.mockResolvedValueOnce(makeView(1));
    act(() => result.current.retryCommand());
    await waitFor(() => expect(result.current.choicesEnabled).toBe(true));
    expect(result.current.view?.revision).toBe(1);
    expect(submitChoice).toHaveBeenCalledTimes(2); // never resent while confirming
  });

  it('never lets a historical idempotent response replace a newer revision', async () => {
    const { result } = await mount(0);
    submitChoice.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    act(() => result.current.submitChoice('c-a'));
    await waitFor(() => expect(result.current.command?.phase).toBe('retryable'));

    // Meanwhile the session advanced further elsewhere.
    ageDisplayedState();
    getSession.mockResolvedValueOnce(makeView(2));
    focusTab();
    await waitFor(() => expect(result.current.view?.revision).toBe(2));

    // The exact retry returns its original saved response (revision 1).
    const refreshGate = deferred<InteractiveSessionViewDto>();
    submitChoice.mockResolvedValueOnce(makeView(1));
    getSession.mockReturnValueOnce(refreshGate.promise);
    act(() => result.current.retryCommand());
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(3));

    expect(result.current.view?.revision).toBe(2);
    expect(result.current.choicesEnabled).toBe(false);

    await act(async () => refreshGate.resolve(makeView(2)));
    await waitFor(() => expect(result.current.choicesEnabled).toBe(true));
    expect(result.current.view?.revision).toBe(2);
  });

  it('retries a busy session with the same command', async () => {
    const { result } = await mount(0);
    submitChoice.mockRejectedValueOnce(apiError(503, 'SESSION_BUSY'));
    act(() => result.current.submitChoice('c-a'));
    await waitFor(() => expect(result.current.command?.phase).toBe('retryable'));
    expect(result.current.command?.message).toMatch(/busy/i);

    submitChoice.mockResolvedValueOnce(makeView(1));
    getSession.mockResolvedValueOnce(makeView(1));
    act(() => result.current.retryCommand());
    await waitFor(() => expect(result.current.choicesEnabled).toBe(true));

    expect(submitChoice.mock.calls[1]![1]).toEqual(submitChoice.mock.calls[0]![1]);
  });

  it('bounds a hung submission and offers the same command again', async () => {
    const { result } = await mount(0);
    vi.useRealTimers(); // re-faking an active fake clock keeps its old config
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    submitChoice.mockImplementation(
      (_id, _command, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    act(() => result.current.submitChoice('c-a'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);
    });

    expect(result.current.command?.phase).toBe('retryable');
    expect(result.current.choicesEnabled).toBe(false);
    expect(submitChoice).toHaveBeenCalledTimes(1); // no automatic retry
  });
});

describe('useInteractiveReader — server rejections', () => {
  it.each(['REVISION_CONFLICT', 'CHOICE_UNAVAILABLE', 'SESSION_TERMINAL'])(
    '%s reloads authoritative state and does not resubmit',
    async (code) => {
      const { result } = await mount(0);
      submitChoice.mockRejectedValueOnce(apiError(409, code));
      const reload = deferred<InteractiveSessionViewDto>();
      getSession.mockReturnValueOnce(reload.promise);

      act(() => result.current.submitChoice('c-a'));
      await waitFor(() => expect(getSession).toHaveBeenCalledTimes(2));

      // Blocked while the authoritative state is loading, with an explanation.
      expect(result.current.choicesEnabled).toBe(false);
      expect(result.current.notice).toBeTruthy();

      await act(async () => reload.resolve(makeView(5, { choices: [{ id: 'c-b', label: 'B' }] })));
      await waitFor(() => expect(result.current.choicesEnabled).toBe(true));

      expect(result.current.view?.revision).toBe(5);
      expect(result.current.command).toBeNull();
      expect(submitChoice).toHaveBeenCalledTimes(1);
    },
  );

  it('stays blocked, keeping its notice, if the reload after a conflict fails', async () => {
    const { result } = await mount(0);
    submitChoice.mockRejectedValueOnce(apiError(409, 'REVISION_CONFLICT'));
    getSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    act(() => result.current.submitChoice('c-a'));
    await waitFor(() => expect(result.current.syncError).toBeTruthy());
    expect(result.current.choicesEnabled).toBe(false);
    act(() => result.current.submitChoice('c-a'));
    expect(submitChoice).toHaveBeenCalledTimes(1);

    getSession.mockResolvedValueOnce(makeView(4));
    act(() => result.current.retrySync());
    await waitFor(() => expect(result.current.choicesEnabled).toBe(true));
    expect(result.current.view?.revision).toBe(4);
  });

  it('treats IDEMPOTENCY_KEY_REUSED as a client-consistency error without minting a new key', async () => {
    const { result } = await mount(0);
    submitChoice.mockRejectedValueOnce(apiError(409, 'IDEMPOTENCY_KEY_REUSED'));

    act(() => result.current.submitChoice('c-a'));
    await waitFor(() => expect(result.current.command?.phase).toBe('inconsistent'));

    act(() => {
      result.current.retryCommand();
      result.current.submitChoice('c-a');
    });
    expect(submitChoice).toHaveBeenCalledTimes(1);
    expect(result.current.choicesEnabled).toBe(false);
  });

  it('shows the unavailable state when the session disappears during a choice', async () => {
    const { result } = await mount(0);
    submitChoice.mockRejectedValueOnce(apiError(404, 'SESSION_NOT_FOUND'));

    act(() => result.current.submitChoice('c-a'));

    await waitFor(() => expect(result.current.phase).toBe('unavailable'));
    expect(result.current.view).toBeNull();
  });
});

describe('useInteractiveReader — refresh', () => {
  it('does not let a delayed GET overwrite a newer accepted choice response', async () => {
    const { result } = await mount(0);
    ageDisplayedState();
    const staleGet = deferred<InteractiveSessionViewDto>();
    getSession.mockReturnValueOnce(staleGet.promise);
    focusTab();
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(2));

    submitChoice.mockResolvedValueOnce(makeView(1));
    act(() => result.current.submitChoice('c-a'));
    await waitFor(() => expect(result.current.view?.revision).toBe(1));

    await act(async () => staleGet.resolve(makeView(0)));

    expect(result.current.view?.revision).toBe(1);
    expect(result.current.view?.scene.id).toBe('scene-1');
  });

  it('skips a focus refresh while the displayed state is fresh', async () => {
    await mount(0);

    focusTab();
    focusTab();

    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent focus/visibility refreshes into one request', async () => {
    const { result } = await mount(0);
    ageDisplayedState();
    const gate = deferred<InteractiveSessionViewDto>();
    getSession.mockReturnValueOnce(gate.promise);

    focusTab();
    focusTab();
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(getSession).toHaveBeenCalledTimes(2);
    await act(async () => gate.resolve(makeView(1)));
    expect(result.current.view?.revision).toBe(1);
  });

  it('does not poll', async () => {
    vi.useRealTimers(); // re-faking an active fake clock keeps its old config
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval'] });
    getSession.mockResolvedValueOnce(makeView(0));
    renderHook(() => useInteractiveReader(SESSION_ID));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });

    expect(getSession).toHaveBeenCalledTimes(1);
  });
});

describe('useInteractiveReader — stale completions', () => {
  it('ignores a late success and failure from a previous session after a route change', async () => {
    const { result, rerender } = await mount(0);
    const lateSuccess = deferred<InteractiveSessionViewDto>();
    submitChoice.mockReturnValueOnce(lateSuccess.promise);
    act(() => result.current.submitChoice('c-a'));

    getSession.mockResolvedValueOnce(makeView(7, { sessionId: OTHER_SESSION_ID }));
    rerender({ id: OTHER_SESSION_ID });
    await waitFor(() => expect(result.current.view?.sessionId).toBe(OTHER_SESSION_ID));

    // The new reader starts its own choice; the old one finishing must not clear it.
    const newerPending = deferred<InteractiveSessionViewDto>();
    submitChoice.mockReturnValueOnce(newerPending.promise);
    act(() => result.current.submitChoice('c-a'));
    expect(result.current.command?.phase).toBe('submitting');

    await act(async () => lateSuccess.resolve(makeView(1)));
    expect(result.current.view?.sessionId).toBe(OTHER_SESSION_ID);
    expect(result.current.view?.revision).toBe(7);
    expect(result.current.command?.phase).toBe('submitting');
    act(() => result.current.submitChoice('c-a'));
    expect(submitChoice).toHaveBeenCalledTimes(2);

    await act(async () => newerPending.resolve(makeView(8, { sessionId: OTHER_SESSION_ID })));
    expect(result.current.view?.revision).toBe(8);
  });

  it('ignores a late failure from a previous session after a route change', async () => {
    const { result, rerender } = await mount(0);
    const lateFailure = deferred<InteractiveSessionViewDto>();
    submitChoice.mockReturnValueOnce(lateFailure.promise);
    act(() => result.current.submitChoice('c-a'));

    getSession.mockResolvedValueOnce(makeView(2, { sessionId: OTHER_SESSION_ID }));
    rerender({ id: OTHER_SESSION_ID });
    await waitFor(() => expect(result.current.view?.sessionId).toBe(OTHER_SESSION_ID));

    await act(async () => lateFailure.reject(apiError(404, 'SESSION_NOT_FOUND')));

    expect(result.current.phase).toBe('ready');
    expect(result.current.view?.sessionId).toBe(OTHER_SESSION_ID);
    expect(result.current.choicesEnabled).toBe(true);
  });

  it('does nothing further when a response arrives after unmount', async () => {
    const { result, unmount } = await mount(0);
    const gate = deferred<InteractiveSessionViewDto>();
    submitChoice.mockReturnValueOnce(gate.promise);
    act(() => result.current.submitChoice('c-a'));

    unmount();
    await act(async () => gate.reject(new TypeError('Failed to fetch')));
    await act(async () => gate.resolve(makeView(1)));

    expect(getSession).toHaveBeenCalledTimes(1);
    expect(submitChoice).toHaveBeenCalledTimes(1);
  });

  it('aborts in-flight requests on unmount', async () => {
    const signals: AbortSignal[] = [];
    getSession.mockImplementation((_id, signal) => {
      if (signal) signals.push(signal);
      return new Promise(() => undefined);
    });
    const { unmount } = renderHook(() => useInteractiveReader(SESSION_ID));

    unmount();

    expect(signals[0]?.aborted).toBe(true);
  });

  it('ignores a response that completes after the auth session epoch changed', async () => {
    const { result } = await mount(0);
    const gate = deferred<InteractiveSessionViewDto>();
    submitChoice.mockReturnValueOnce(gate.promise);
    act(() => result.current.submitChoice('c-a'));

    act(() => {
      advanceSessionEpoch();
    });
    await act(async () => gate.resolve(makeView(1)));

    expect(result.current.view?.revision).toBe(0);
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it('survives logout followed by login as the same account', async () => {
    const { result, rerender } = await mount(0);
    const gate = deferred<InteractiveSessionViewDto>();
    submitChoice.mockReturnValueOnce(gate.promise);
    act(() => result.current.submitChoice('c-a'));
    expect(result.current.command?.phase).toBe('submitting');

    // Logout, then login as the very same user id.
    act(() => {
      advanceSessionEpoch();
    });
    auth = { status: 'anon', user: null };
    rerender({ id: SESSION_ID });
    expect(result.current.view).toBeNull();

    act(() => {
      advanceSessionEpoch();
    });
    auth = { status: 'authed', user: { id: 'user-1' } };
    getSession.mockResolvedValueOnce(makeView(0));
    rerender({ id: SESSION_ID });
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.command).toBeNull();

    await act(async () => gate.resolve(makeView(1)));

    expect(result.current.view?.revision).toBe(0);
    expect(result.current.command).toBeNull();
    expect(result.current.choicesEnabled).toBe(true);
  });

  it('drops the previous account’s story when the user changes', async () => {
    const { result, rerender } = await mount(3);
    const gate = deferred<InteractiveSessionViewDto>();
    submitChoice.mockReturnValueOnce(gate.promise);
    act(() => result.current.submitChoice('c-a'));

    auth = { status: 'authed', user: { id: 'user-2' } };
    const foreign = deferred<InteractiveSessionViewDto>();
    getSession.mockReturnValueOnce(foreign.promise);
    rerender({ id: SESSION_ID });
    expect(result.current.view).toBeNull();

    await act(async () => gate.resolve(makeView(4)));
    expect(result.current.view).toBeNull();

    await act(async () => foreign.reject(apiError(404, 'SESSION_NOT_FOUND')));
    expect(result.current.phase).toBe('unavailable');
  });
});
