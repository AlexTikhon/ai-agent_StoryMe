import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { InteractiveSessionMetadataDto, InteractiveSessionViewDto } from '@book/types';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { advanceSessionEpoch } from '@/lib/auth/token-store';
import { SESSION_ID, deferred, makeMetadata, makeView } from '../interactive-test-fixtures';
import {
  DEFAULT_READER_TITLE,
  SESSION_METADATA_DEADLINE_MS,
  useSessionMetadata,
} from './use-session-metadata';

vi.mock('@/lib/api/interactive', () => ({
  interactiveApi: { getSessionMetadata: vi.fn() },
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: vi.fn() }));

const getSessionMetadata = vi.mocked(interactiveApi.getSessionMetadata);

let auth: { status: string; user: { id: string } | null };

function mount(initial: InteractiveSessionViewDto | null) {
  return renderHook(({ view }) => useSessionMetadata(view), { initialProps: { view: initial } });
}

beforeEach(() => {
  auth = { status: 'authed', user: { id: 'user-1' } };
  vi.mocked(useAuth).mockImplementation(() => auth as unknown as ReturnType<typeof useAuth>);
  getSessionMetadata.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSessionMetadata', () => {
  it('shows the generic title and sends nothing without a view or while signed out', () => {
    const empty = mount(null);
    expect(empty.result.current.title).toBe(DEFAULT_READER_TITLE);
    auth = { status: 'anon', user: null };
    const anon = mount(makeView(0));
    expect(anon.result.current.title).toBe(DEFAULT_READER_TITLE);
    expect(getSessionMetadata).not.toHaveBeenCalled();
  });

  it('shows the server-provided title of a test-only scenario', async () => {
    const view = makeView(0, { scenarioId: 'test-second-story', scenarioVersion: 3 });
    getSessionMetadata.mockResolvedValueOnce(
      makeMetadata({ scenarioId: 'test-second-story', scenarioVersion: 3, title: 'Second Story' }),
    );
    const hook = mount(view);

    expect(hook.result.current.title).toBe(DEFAULT_READER_TITLE);
    await waitFor(() => expect(hook.result.current.title).toBe('Second Story'));
    expect(getSessionMetadata.mock.calls[0]![0]).toBe(SESSION_ID);
  });

  it('an older-version session keeps its own title and never adopts a latest-version one', async () => {
    const view = makeView(0, { scenarioVersion: 1 });
    // A (hypothetical) answer describing the latest version is not this session's.
    getSessionMetadata.mockResolvedValueOnce(
      makeMetadata({ scenarioVersion: 2, title: 'Latest Title v2' }),
    );
    const hook = mount(view);
    await waitFor(() => expect(getSessionMetadata).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(hook.result.current.title).toBe(DEFAULT_READER_TITLE);

    getSessionMetadata.mockResolvedValueOnce(
      makeMetadata({ scenarioVersion: 1, title: 'Title v1' }),
    );
    const older = mount(makeView(0, { scenarioVersion: 1 }));
    await waitFor(() => expect(older.result.current.title).toBe('Title v1'));
  });

  it('fetches once per session: scene and revision changes never refetch', async () => {
    getSessionMetadata.mockResolvedValue(makeMetadata());
    const hook = mount(makeView(0));
    await waitFor(() => expect(hook.result.current.title).toBe('The Last Delivery'));

    hook.rerender({ view: makeView(1) });
    hook.rerender({ view: makeView(2) });
    hook.rerender({ view: makeView(3, { status: 'ended' }) });

    expect(hook.result.current.title).toBe('The Last Delivery');
    expect(getSessionMetadata).toHaveBeenCalledTimes(1); // no polling either
  });

  it.each([
    ['another session', { sessionId: '00000000-0000-4000-8000-000000000009' }],
    ['another scenario id', { scenarioId: 'other-story' }],
    ['another version', { scenarioVersion: 2 }],
  ])('degrades to the generic title when the answer is for %s', async (_label, patch) => {
    getSessionMetadata.mockResolvedValueOnce(makeMetadata(patch));
    const hook = mount(makeView(0));
    await waitFor(() => expect(getSessionMetadata).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(hook.result.current.title).toBe(DEFAULT_READER_TITLE);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['multi-line', 'a\nb'],
    ['over-long', 'x'.repeat(81)],
    ['non-string', 42],
  ])('degrades to the generic title for a %s title', async (_label, title) => {
    getSessionMetadata.mockResolvedValueOnce({
      ...makeMetadata(),
      title,
    } as unknown as InteractiveSessionMetadataDto);
    const hook = mount(makeView(0));
    await waitFor(() => expect(getSessionMetadata).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(hook.result.current.title).toBe(DEFAULT_READER_TITLE);
  });

  it('degrades to the generic title on a failure, and does not retry on its own', async () => {
    getSessionMetadata.mockRejectedValue(new ApiError(503, 'SERVICE_UNAVAILABLE', 'down'));
    const hook = mount(makeView(0));
    await waitFor(() => expect(getSessionMetadata).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(hook.result.current.title).toBe(DEFAULT_READER_TITLE);
    hook.rerender({ view: makeView(1) });
    expect(getSessionMetadata).toHaveBeenCalledTimes(1);
  });

  it('survives a synchronous throw from the API layer', async () => {
    getSessionMetadata.mockImplementation(() => {
      throw new Error('offline');
    });
    const hook = mount(makeView(0));
    await waitFor(() => expect(getSessionMetadata).toHaveBeenCalledTimes(1));
    expect(hook.result.current.title).toBe(DEFAULT_READER_TITLE);
  });

  it('aborts at the deadline and keeps the generic title', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    getSessionMetadata.mockImplementation((_id, s) => {
      signal = s;
      return new Promise(() => {});
    });
    const hook = mount(makeView(0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(signal?.aborted).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_METADATA_DEADLINE_MS);
    });
    expect(signal?.aborted).toBe(true);
    expect(hook.result.current.title).toBe(DEFAULT_READER_TITLE);
  });

  it('drops a late answer after a route change and clears the old title synchronously', async () => {
    const otherId = '00000000-0000-4000-8000-000000000002';
    const first = makeView(0);
    const second = makeView(0, { sessionId: otherId });
    const gate0 = deferred<InteractiveSessionMetadataDto>();
    const gate1 = deferred<InteractiveSessionMetadataDto>();
    getSessionMetadata.mockReturnValueOnce(gate0.promise).mockReturnValueOnce(gate1.promise);
    const hook = mount(first);
    await act(async () => gate0.resolve(makeMetadata({ title: 'Story One' })));
    expect(hook.result.current.title).toBe('Story One');

    hook.rerender({ view: second });
    expect(hook.result.current.title).toBe(DEFAULT_READER_TITLE); // same render, no stale title

    await act(async () => gate1.resolve(makeMetadata({ sessionId: otherId, title: 'Story Two' })));
    expect(hook.result.current.title).toBe('Story Two');
  });

  it('a delayed answer for a previous session cannot replace the current title', async () => {
    const otherId = '00000000-0000-4000-8000-000000000002';
    const gate0 = deferred<InteractiveSessionMetadataDto>();
    const gate1 = deferred<InteractiveSessionMetadataDto>();
    getSessionMetadata.mockReturnValueOnce(gate0.promise).mockReturnValueOnce(gate1.promise);
    const hook = mount(makeView(0));
    hook.rerender({ view: makeView(0, { sessionId: otherId }) });
    await waitFor(() => expect(getSessionMetadata).toHaveBeenCalledTimes(2));

    await act(async () => gate1.resolve(makeMetadata({ sessionId: otherId, title: 'Current' })));
    await act(async () => gate0.resolve(makeMetadata({ title: 'Stale' })));
    expect(hook.result.current.title).toBe('Current');
  });

  it('drops an answer that arrives after unmount', async () => {
    const gate = deferred<InteractiveSessionMetadataDto>();
    getSessionMetadata.mockReturnValueOnce(gate.promise);
    const hook = mount(makeView(0));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    hook.unmount();
    await act(async () => gate.resolve(makeMetadata()));
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('drops an answer that crosses an auth-session change', async () => {
    const gate = deferred<InteractiveSessionMetadataDto>();
    getSessionMetadata.mockReturnValueOnce(gate.promise);
    const hook = mount(makeView(0));
    await waitFor(() => expect(getSessionMetadata).toHaveBeenCalledTimes(1));

    advanceSessionEpoch();
    await act(async () => gate.resolve(makeMetadata({ title: 'Previous account' })));
    expect(hook.result.current.title).toBe(DEFAULT_READER_TITLE);
  });

  it('refetches for a different account and never shows the previous account title', async () => {
    getSessionMetadata.mockResolvedValueOnce(makeMetadata({ title: 'Account One' }));
    const hook = mount(makeView(0));
    await waitFor(() => expect(hook.result.current.title).toBe('Account One'));

    const gate = deferred<InteractiveSessionMetadataDto>();
    getSessionMetadata.mockReturnValueOnce(gate.promise);
    auth = { status: 'authed', user: { id: 'user-2' } };
    hook.rerender({ view: makeView(0) });

    expect(hook.result.current.title).toBe(DEFAULT_READER_TITLE);
    await waitFor(() => expect(getSessionMetadata).toHaveBeenCalledTimes(2));
    await act(async () => gate.resolve(makeMetadata({ title: 'Account Two' })));
    expect(hook.result.current.title).toBe('Account Two');
  });
});
