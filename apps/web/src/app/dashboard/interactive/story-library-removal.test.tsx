import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { advanceSessionEpoch } from '@/lib/auth/token-store';
import { deferred, makeCatalogue, makePage, makeSummary } from './interactive-test-fixtures';
import InteractiveIntroPage from './page';
import { REMOVAL_DEADLINE_MS, useSessionLibrary } from './use-session-library';

vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));
vi.mock('next/link', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, className, ...rest }: any) => (
    <a href={href} className={className} onClick={(e) => e.preventDefault()} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: vi.fn() }));
vi.mock('@/lib/api/interactive', () => ({
  interactiveApi: {
    listScenarios: vi.fn(),
    createSession: vi.fn(),
    listSessions: vi.fn(),
    removeSession: vi.fn(),
  },
}));

const listScenarios = vi.mocked(interactiveApi.listScenarios);
const listSessions = vi.mocked(interactiveApi.listSessions);
const removeSession = vi.mocked(interactiveApi.removeSession);
type Page = ReturnType<typeof makePage>;

function signInAs(id: string) {
  vi.mocked(useAuth).mockReturnValue({
    status: 'authed',
    user: { id },
  } as unknown as ReturnType<typeof useAuth>);
}

beforeEach(() => {
  vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as unknown as ReturnType<
    typeof useRouter
  >);
  signInAs('user-1');
  listScenarios.mockReset();
  listScenarios.mockResolvedValue(makeCatalogue());
  listSessions.mockReset();
  removeSession.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

const library = () => screen.getByRole('region', { name: 'Your stories' });
const rows = () => within(library()).getAllByRole('listitem');
const linkFor = (n: number) => library().querySelector(`a[href*="${makeSummary(n).sessionId}"]`);
const rowFor = (n: number) => {
  const item = linkFor(n)?.closest('li');
  if (!item) throw new Error(`No row for story ${n}`);
  return item as HTMLElement;
};
const hasRow = (n: number) => linkFor(n) !== null;

const active = makeSummary(2);
const completed = makeSummary(1, { status: 'ended', endingTitle: 'A Quiet Delivery' });

async function openConfirmation(n: number) {
  await userEvent.click(within(rowFor(n)).getByRole('button', { name: /^Remove / }));
  return within(rowFor(n)).getByRole('group', { name: /^Remove .* from your stories\?/ });
}

async function confirmRemoval(n: number) {
  const group = await openConfirmation(n);
  await userEvent.click(within(group).getByRole('button', { name: /^Yes, remove/ }));
}

describe('removing a story from the library', () => {
  it('asks before removing an unfinished or a completed story, and says what removal means', async () => {
    listSessions.mockResolvedValueOnce(makePage([active, completed]));
    render(<InteractiveIntroPage />);
    await within(library()).findAllByRole('listitem');

    const unfinished = await openConfirmation(2);
    expect(unfinished).toHaveTextContent(/can no longer continue it/);
    expect(unfinished).toHaveTextContent(/does not erase/);

    const finished = await openConfirmation(1);
    expect(finished).toHaveTextContent(/can no longer read it again/);
    expect(finished).toHaveTextContent(/does not erase/);

    // Opening a second confirmation replaces the first: one pending question at a time.
    expect(within(rowFor(2)).queryByRole('group')).toBeNull();
    expect(removeSession).not.toHaveBeenCalled();
  });

  it('cancelling sends nothing, keeps the story and returns focus to its Remove button', async () => {
    listSessions.mockResolvedValueOnce(makePage([active]));
    render(<InteractiveIntroPage />);
    await within(library()).findAllByRole('listitem');

    const group = await openConfirmation(2);
    await userEvent.click(within(group).getByRole('button', { name: 'Cancel' }));

    expect(removeSession).not.toHaveBeenCalled();
    expect(within(rowFor(2)).queryByRole('group')).toBeNull();
    expect(within(rowFor(2)).getByRole('button', { name: /^Remove / })).toHaveFocus();
    expect(within(rowFor(2)).getByRole('link', { name: /Continue/ })).toBeInTheDocument();
  });

  it('keeps the row until the server acknowledges, sends one DELETE for a double click, then refreshes the first page', async () => {
    const ack = deferred<void>();
    const refreshed = deferred<Page>();
    listSessions.mockResolvedValueOnce(makePage([active, completed], 'cursor-1'));
    listSessions.mockReturnValueOnce(refreshed.promise);
    removeSession.mockReturnValueOnce(ack.promise);
    render(<InteractiveIntroPage />);
    await within(library()).findAllByRole('listitem');

    const group = await openConfirmation(1);
    await userEvent.dblClick(within(group).getByRole('button', { name: /^Yes, remove/ }));

    expect(removeSession).toHaveBeenCalledTimes(1);
    expect(removeSession).toHaveBeenCalledWith(completed.sessionId, expect.any(AbortSignal));
    expect(hasRow(1)).toBe(true);
    expect(within(rowFor(1)).getByRole('status')).toHaveTextContent(/Removing/);
    // One removal command at a time: other stories cannot start one meanwhile.
    expect(within(rowFor(2)).getByRole('button', { name: /^Remove / })).toBeDisabled();

    await act(async () => ack.resolve());

    expect(hasRow(1)).toBe(false); // gone immediately, before the refresh answers
    expect(hasRow(2)).toBe(true);
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(listSessions).toHaveBeenLastCalledWith({ limit: 20, cursor: null }, expect.any(Object));
    expect(within(library()).getByRole('status')).toHaveTextContent(/removed/i);

    await act(async () => refreshed.resolve(makePage([active], null)));
    expect(rows()).toHaveLength(1);
    expect(within(library()).queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(removeSession).toHaveBeenCalledTimes(1);
  });

  it('never restores an acknowledged row when the follow-up refresh fails', async () => {
    listSessions.mockResolvedValueOnce(makePage([active, completed]));
    listSessions.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    removeSession.mockResolvedValueOnce(undefined);
    render(<InteractiveIntroPage />);
    await within(library()).findAllByRole('listitem');

    await confirmRemoval(2);

    expect(await within(library()).findByText(/out of date/)).toBeInTheDocument();
    expect(hasRow(2)).toBe(false);
    expect(within(rowFor(1)).getByRole('link', { name: /Read again/ })).toBeInTheDocument();
    // The remaining library stays usable: a manual refresh recovers.
    listSessions.mockResolvedValueOnce(makePage([completed]));
    await userEvent.click(within(library()).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(within(library()).queryByText(/out of date/)).toBeNull());
    expect(rows()).toHaveLength(1);
  });

  it('ignores a pagination response that was already in flight when the removal was acknowledged', async () => {
    const more = deferred<Page>();
    listSessions.mockResolvedValueOnce(makePage([makeSummary(3), active], 'cursor-1'));
    listSessions.mockReturnValueOnce(more.promise); // load more
    listSessions.mockResolvedValueOnce(makePage([makeSummary(3)], 'cursor-fresh')); // post-ack refresh
    removeSession.mockResolvedValueOnce(undefined);
    render(<InteractiveIntroPage />);
    await within(library()).findAllByRole('listitem');
    await userEvent.click(within(library()).getByRole('button', { name: 'Load more' }));

    await confirmRemoval(2);
    await waitFor(() => expect(rows()).toHaveLength(1));
    await act(async () => more.resolve(makePage([active, completed], null)));

    expect(rows()).toHaveLength(1);
    expect(hasRow(2)).toBe(false);
    expect(hasRow(1)).toBe(false);
    // Pagination restarted from the refreshed first page, not the stale cursor.
    expect(within(library()).getByRole('button', { name: 'Load more' })).toBeEnabled();
  });

  it('ignores a pre-removal refresh that answers after the acknowledgement', async () => {
    const early = deferred<Page>();
    listSessions.mockResolvedValueOnce(makePage([active, completed]));
    listSessions.mockReturnValueOnce(early.promise); // manual refresh before removing
    listSessions.mockRejectedValueOnce(new ApiError(503, 'down')); // post-ack refresh
    removeSession.mockResolvedValueOnce(undefined);
    render(<InteractiveIntroPage />);
    await within(library()).findAllByRole('listitem');
    await userEvent.click(within(library()).getByRole('button', { name: 'Refresh' }));

    await confirmRemoval(1);
    await within(library()).findByText(/out of date/);
    await act(async () => early.resolve(makePage([active, completed])));

    expect(hasRow(1)).toBe(false);
    expect(hasRow(2)).toBe(true);
  });

  describe('failures', () => {
    it('keeps the row after a lost response and retries the identical DELETE only on request', async () => {
      listSessions.mockResolvedValue(makePage([active, completed]));
      removeSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      removeSession.mockResolvedValueOnce(undefined);
      render(<InteractiveIntroPage />);
      await within(library()).findAllByRole('listitem');

      await confirmRemoval(2);

      const alert = await within(rowFor(2)).findByRole('alert');
      expect(alert).toHaveTextContent(/couldn.t confirm/i);
      expect(alert).toHaveTextContent(/may or may not/i);
      expect(hasRow(2)).toBe(true);
      expect(removeSession).toHaveBeenCalledTimes(1); // nothing is retried by itself

      listSessions.mockResolvedValueOnce(makePage([completed]));
      await userEvent.click(within(rowFor(2)).getByRole('button', { name: 'Try again' }));

      await waitFor(() => expect(hasRow(2)).toBe(false));
      expect(removeSession).toHaveBeenCalledTimes(2);
      expect(removeSession.mock.calls[1]![0]).toBe(active.sessionId);
    });

    it.each([
      ['rate limiting', new ApiError(429, 'slow', 'RATE_LIMITED'), /too quickly/i],
      ['a temporary server failure', new ApiError(503, 'down'), /having trouble/i],
    ])('offers a manual retry for %s', async (_name, failure, text) => {
      listSessions.mockResolvedValue(makePage([active]));
      removeSession.mockRejectedValueOnce(failure);
      render(<InteractiveIntroPage />);
      await within(library()).findAllByRole('listitem');

      await confirmRemoval(2);

      const alert = await within(rowFor(2)).findByRole('alert');
      expect(alert).toHaveTextContent(text);
      expect(within(rowFor(2)).getByRole('button', { name: 'Try again' })).toBeEnabled();
      expect(removeSession).toHaveBeenCalledTimes(1);
    });

    it('does not offer a retry for a definitive rejection, and Dismiss clears the message', async () => {
      listSessions.mockResolvedValue(makePage([active]));
      removeSession.mockRejectedValueOnce(new ApiError(400, 'bad id', 'VALIDATION_FAILED'));
      render(<InteractiveIntroPage />);
      await within(library()).findAllByRole('listitem');

      await confirmRemoval(2);

      await within(rowFor(2)).findByRole('alert');
      expect(within(rowFor(2)).queryByRole('button', { name: 'Try again' })).toBeNull();
      await userEvent.click(within(rowFor(2)).getByRole('button', { name: 'Dismiss' }));
      expect(within(rowFor(2)).queryByRole('alert')).toBeNull();
      expect(removeSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('lifetime and scope', () => {
    it('aborts a pending DELETE on unmount and ignores its late result', async () => {
      const ack = deferred<void>();
      let signal: AbortSignal | undefined;
      listSessions.mockResolvedValue(makePage([active]));
      removeSession.mockImplementationOnce((_id, s) => {
        signal = s;
        return ack.promise;
      });
      const { unmount } = render(<InteractiveIntroPage />);
      await within(library()).findAllByRole('listitem');
      await confirmRemoval(2);
      const callsBefore = listSessions.mock.calls.length;

      unmount();
      expect(signal?.aborted).toBe(true);
      await act(async () => ack.resolve());

      expect(listSessions).toHaveBeenCalledTimes(callsBefore); // no refresh after unmount
    });

    it('drops a pending confirmation and a pending DELETE when the account changes', async () => {
      const ack = deferred<void>();
      listSessions.mockResolvedValueOnce(makePage([active]));
      removeSession.mockReturnValueOnce(ack.promise);
      const { rerender } = render(<InteractiveIntroPage />);
      await within(library()).findAllByRole('listitem');
      await confirmRemoval(2);

      signInAs('user-2');
      listSessions.mockResolvedValueOnce(makePage([active, completed]));
      rerender(<InteractiveIntroPage />);
      await within(library()).findByText('Ending: A Quiet Delivery');

      expect(screen.queryByText(/Removing/)).toBeNull();
      expect(within(rowFor(2)).getByRole('button', { name: /^Remove / })).toBeEnabled();
      const callsBefore = listSessions.mock.calls.length;
      await act(async () => ack.resolve());

      expect(listSessions).toHaveBeenCalledTimes(callsBefore);
      expect(rows()).toHaveLength(2); // user one's acknowledgement never touched user two's list
    });

    it('drops a pending confirmation and a late acknowledgement when the same account gets a new auth session', async () => {
      const ack = deferred<void>();
      listSessions.mockResolvedValue(makePage([active, completed]));
      removeSession.mockReturnValueOnce(ack.promise);
      const { rerender } = render(<InteractiveIntroPage />);
      await within(library()).findAllByRole('listitem');
      await openConfirmation(1);
      await userEvent.click(within(rowFor(1)).getByRole('button', { name: /^Yes, remove/ }));

      advanceSessionEpoch(); // logout/login into the same account
      rerender(<InteractiveIntroPage />);
      await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
      await within(library()).findAllByRole('listitem');
      expect(screen.queryByText(/Removing/)).toBeNull();

      await act(async () => ack.resolve());

      expect(listSessions).toHaveBeenCalledTimes(2);
      expect(hasRow(1)).toBe(true);
    });
  });

  describe('useSessionLibrary removal (hook level)', () => {
    it('gives up waiting after the deadline, then retries the same session on request', async () => {
      vi.useFakeTimers();
      listSessions.mockResolvedValue(makePage([active, completed]));
      removeSession.mockImplementationOnce(
        (_id, signal) =>
          new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      );
      removeSession.mockResolvedValueOnce(undefined);
      const { result } = renderHook(() => useSessionLibrary());
      await act(async () => {});
      expect(result.current.phase).toBe('ready');

      act(() => result.current.requestRemoval(completed.sessionId));
      act(() => result.current.confirmRemoval());
      expect(result.current.removal).toMatchObject({ status: 'removing' });
      await act(async () => {
        vi.advanceTimersByTime(REMOVAL_DEADLINE_MS);
      });

      expect(removeSession.mock.calls[0]![1]?.aborted).toBe(true);
      expect(result.current.removal).toMatchObject({
        sessionId: completed.sessionId,
        status: 'failed',
        error: 'timeout',
      });
      expect(result.current.sessions).toHaveLength(2);
      expect(removeSession).toHaveBeenCalledTimes(1);

      listSessions.mockResolvedValueOnce(makePage([active])); // the server no longer lists it
      act(() => result.current.retryRemoval());
      await act(async () => {});

      expect(removeSession).toHaveBeenCalledTimes(2);
      expect(removeSession.mock.calls[1]![0]).toBe(completed.sessionId);
      expect(result.current.sessions.map((s) => s.sessionId)).toEqual([active.sessionId]);
      expect(result.current.removal).toBeNull();
    });

    it('ignores confirm and retry when nothing is awaiting them', async () => {
      listSessions.mockResolvedValue(makePage([active]));
      const { result } = renderHook(() => useSessionLibrary());
      await waitFor(() => expect(result.current.phase).toBe('ready'));

      act(() => {
        result.current.confirmRemoval();
        result.current.retryRemoval();
        result.current.cancelRemoval();
      });

      expect(removeSession).not.toHaveBeenCalled();
      expect(result.current.removal).toBeNull();
    });
  });
});
