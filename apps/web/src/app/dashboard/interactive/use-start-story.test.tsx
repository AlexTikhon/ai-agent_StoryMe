import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { advanceSessionEpoch } from '@/lib/auth/token-store';
import { SESSION_ID, deferred, makeView } from './interactive-test-fixtures';
import { useStartStory } from './use-start-story';

vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: vi.fn() }));
vi.mock('@/lib/api/interactive', () => ({ interactiveApi: { createSession: vi.fn() } }));

const createSession = vi.mocked(interactiveApi.createSession);
const pushMock = vi.fn();

const V1 = { scenarioId: 'warsaw-last-delivery', scenarioVersion: 1 };
const V2 = { scenarioId: 'warsaw-last-delivery', scenarioVersion: 2 };
const OTHER = { scenarioId: 'test-second-story', scenarioVersion: 1 };

beforeEach(() => {
  vi.mocked(useRouter).mockReturnValue({ push: pushMock } as unknown as ReturnType<
    typeof useRouter
  >);
  vi.mocked(useAuth).mockReturnValue({
    status: 'authed',
    user: { id: 'user-1' },
  } as unknown as ReturnType<typeof useAuth>);
  createSession.mockReset();
  pushMock.mockReset();
});

describe('useStartStory', () => {
  it('sends the exact target with one fresh idempotency key', async () => {
    createSession.mockResolvedValueOnce(makeView(0));
    const { result } = renderHook(() => useStartStory());

    act(() => result.current.start(V2));

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]![0]).toEqual({
      ...V2,
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(`/dashboard/interactive/${SESSION_ID}`),
    );
  });

  it('ignores a start for another story while the first is in flight', () => {
    createSession.mockReturnValueOnce(deferred<ReturnType<typeof makeView>>().promise);
    const { result } = renderHook(() => useStartStory());

    act(() => {
      result.current.start(V1);
      result.current.start(OTHER);
      result.current.start(V1);
    });

    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('ignores a start for another story while an ambiguous command awaits its retry', async () => {
    createSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useStartStory());
    act(() => result.current.start(V1));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.active).toEqual(V1);

    act(() => {
      result.current.start(OTHER);
      result.current.start(V2);
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(result.current.active).toEqual(V1);
  });

  it('retry resends the identical command byte for byte', async () => {
    createSession.mockRejectedValueOnce(new ApiError(503, 'down'));
    createSession.mockResolvedValueOnce(makeView(0));
    const { result } = renderHook(() => useStartStory());
    act(() => result.current.start(V1));
    await waitFor(() => expect(result.current.starting).toBe(false));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    act(() => result.current.retry());

    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    const [first, second] = createSession.mock.calls.map(([command]) => JSON.stringify(command));
    expect(second).toBe(first);
  });

  it('retry is a no-op without a held command and never starts anything', () => {
    const { result } = renderHook(() => useStartStory());
    act(() => result.current.retry());
    expect(createSession).not.toHaveBeenCalled();
  });

  it('resolves the command on a definitive rejection, so the next start is new', async () => {
    createSession.mockRejectedValueOnce(new ApiError(422, 'nope', 'UNKNOWN_SCENARIO'));
    createSession.mockResolvedValueOnce(makeView(0));
    const { result } = renderHook(() => useStartStory());
    act(() => result.current.start(V1));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.active).toBeNull();

    act(() => result.current.retry()); // nothing to resend
    expect(createSession).toHaveBeenCalledTimes(1);

    act(() => result.current.start(OTHER));
    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    expect(createSession.mock.calls[1]![0]).toMatchObject(OTHER);
    expect(createSession.mock.calls[1]![0].idempotencyKey).not.toBe(
      createSession.mock.calls[0]![0].idempotencyKey,
    );
  });

  it('drops the command and navigates nowhere when the account changes mid-flight', async () => {
    const gate = deferred<ReturnType<typeof makeView>>();
    createSession.mockReturnValueOnce(gate.promise);
    const { result, rerender } = renderHook(() => useStartStory());
    act(() => result.current.start(V1));

    vi.mocked(useAuth).mockReturnValue({
      status: 'authed',
      user: { id: 'user-2' },
    } as unknown as ReturnType<typeof useAuth>);
    rerender();
    gate.resolve(makeView(0));
    await Promise.resolve();
    await Promise.resolve();

    expect(pushMock).not.toHaveBeenCalled();
    expect(result.current.active).toBeNull();
    act(() => result.current.retry()); // the previous account's command is gone
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('does not navigate when the auth epoch advanced before the response', async () => {
    const gate = deferred<ReturnType<typeof makeView>>();
    createSession.mockReturnValueOnce(gate.promise);
    const { result } = renderHook(() => useStartStory());
    act(() => result.current.start(V1));

    advanceSessionEpoch();
    gate.resolve(makeView(0));
    await Promise.resolve();
    await Promise.resolve();

    expect(pushMock).not.toHaveBeenCalled();
  });
});
