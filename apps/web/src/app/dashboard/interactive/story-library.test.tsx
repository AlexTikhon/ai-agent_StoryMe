import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { advanceSessionEpoch } from '@/lib/auth/token-store';
import {
  deferred,
  makeCatalogue,
  makePage,
  makeSummary,
  makeView,
} from './interactive-test-fixtures';
import InteractiveIntroPage from './page';
import { useSessionLibrary } from './use-session-library';

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
    getSession: vi.fn(),
    submitChoice: vi.fn(),
  },
}));

const listScenarios = vi.mocked(interactiveApi.listScenarios);
const createSession = vi.mocked(interactiveApi.createSession);
const listSessions = vi.mocked(interactiveApi.listSessions);
const pushMock = vi.fn();
type Page = ReturnType<typeof makePage>;

function signInAs(id: string) {
  vi.mocked(useAuth).mockReturnValue({
    status: 'authed',
    user: { id },
  } as unknown as ReturnType<typeof useAuth>);
}

beforeEach(() => {
  vi.mocked(useRouter).mockReturnValue({ push: pushMock } as unknown as ReturnType<
    typeof useRouter
  >);
  signInAs('user-1');
  listScenarios.mockReset();
  listScenarios.mockResolvedValue(makeCatalogue());
  createSession.mockReset();
  listSessions.mockReset();
  pushMock.mockReset();
});

const library = () => screen.getByRole('region', { name: 'Your stories' });

describe('Your stories library', () => {
  it('shows a loading state, then an empty state with the explicit Start story action intact', async () => {
    const gate = deferred<Page>();
    listSessions.mockReturnValueOnce(gate.promise);
    render(<InteractiveIntroPage />);

    expect(within(library()).getByRole('status')).toHaveTextContent('Loading your stories');
    expect(await screen.findByRole('button', { name: /^Start story/ })).toBeEnabled();

    gate.resolve(makePage([]));
    expect(await within(library()).findByText(/No stories yet/)).toBeInTheDocument();
    expect(listSessions).toHaveBeenCalledWith({ limit: 20, cursor: null }, expect.any(AbortSignal));
    expect(createSession).not.toHaveBeenCalled();
  });

  it('lists active and completed stories distinctly, each resuming through its reader URL', async () => {
    const active = makeSummary(2, { sceneTitle: 'Flat 4' });
    const done = makeSummary(1, {
      status: 'ended',
      sceneTitle: 'A quiet delivery',
      endingTitle: 'A Quiet Delivery',
    });
    listSessions.mockResolvedValueOnce(makePage([active, done]));
    render(<InteractiveIntroPage />);

    const items = await within(library()).findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('In progress')).toBeInTheDocument();
    expect(within(items[0]!).getByText('At: Flat 4')).toBeInTheDocument();
    expect(within(items[0]!).getByRole('link', { name: /Continue/ })).toHaveAttribute(
      'href',
      `/dashboard/interactive/${active.sessionId}`,
    );
    expect(within(items[1]!).getByText('Completed')).toBeInTheDocument();
    expect(within(items[1]!).getByText('Ending: A Quiet Delivery')).toBeInTheDocument();
    expect(within(items[1]!).getByRole('link', { name: /Read again/ })).toHaveAttribute(
      'href',
      `/dashboard/interactive/${done.sessionId}/transcript`,
    );
  });

  it('titles each story from the server-provided scenarioTitle, not from a browser map', async () => {
    listSessions.mockResolvedValueOnce(
      makePage([
        makeSummary(2, { scenarioId: 'test-second-story', scenarioTitle: 'The Second Test Story' }),
        makeSummary(1, { scenarioId: 'warsaw-last-delivery', scenarioTitle: 'Server Chosen Name' }),
      ]),
    );
    render(<InteractiveIntroPage />);

    const items = await within(library()).findAllByRole('listitem');
    expect(within(items[0]!).getByText('The Second Test Story')).toBeInTheDocument();
    expect(within(items[0]!).getByRole('link')).toHaveAccessibleName(
      /^Continue The Second Test Story, in progress/,
    );
    // A known id no longer implies a known title: only the server decides.
    expect(within(items[1]!).getByText('Server Chosen Name')).toBeInTheDocument();
    expect(within(items[1]!).queryByText('The Last Delivery')).not.toBeInTheDocument();
  });

  it('falls back to a generic title when the server sends none', async () => {
    const summary = makeSummary(1) as unknown as Record<string, unknown>;
    delete summary['scenarioTitle'];
    listSessions.mockResolvedValueOnce(
      makePage([
        summary as unknown as ReturnType<typeof makeSummary>,
        makeSummary(2, { scenarioTitle: '  ' }),
      ]),
    );
    render(<InteractiveIntroPage />);

    const items = await within(library()).findAllByRole('listitem');
    for (const item of items) {
      expect(within(item).getByText('Interactive story')).toBeInTheDocument();
    }
  });

  it('resuming a story never creates a session', async () => {
    listSessions.mockResolvedValueOnce(makePage([makeSummary(1)]));
    render(<InteractiveIntroPage />);

    await userEvent.click(await within(library()).findByRole('link', { name: /Continue/ }));

    expect(createSession).not.toHaveBeenCalled();
  });

  it('reveals a committed session after a lost creation response by refreshing the library', async () => {
    const committed = makeSummary(3, { sceneTitle: 'Praga courtyard' });
    listSessions.mockResolvedValueOnce(makePage([])).mockResolvedValueOnce(makePage([committed]));
    createSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<InteractiveIntroPage />);
    await within(library()).findByText(/No stories yet/);

    await userEvent.click(await screen.findByRole('button', { name: /^Start story/ }));
    expect(await screen.findByText(/won.t start a second story/i)).toBeInTheDocument();
    await userEvent.click(within(library()).getByRole('button', { name: 'Refresh' }));

    const link = await within(library()).findByRole('link', { name: /Continue/ });
    expect(link).toHaveAttribute('href', `/dashboard/interactive/${committed.sessionId}`);
    expect(createSession).toHaveBeenCalledTimes(1); // refreshing did not create anything
  });

  it('offers retry after a load failure and recovers', async () => {
    listSessions.mockRejectedValueOnce(new ApiError(503, 'down'));
    listSessions.mockResolvedValueOnce(makePage([makeSummary(1)]));
    render(<InteractiveIntroPage />);

    expect(await within(library()).findByRole('alert')).toHaveTextContent(
      /couldn.t load your stories/i,
    );
    await userEvent.click(within(library()).getByRole('button', { name: 'Try again' }));

    expect(await within(library()).findByRole('link', { name: /Continue/ })).toBeInTheDocument();
    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it('explains a rate-limited list without retrying by itself', async () => {
    listSessions.mockRejectedValueOnce(new ApiError(429, 'HTTP 429', 'RATE_LIMITED'));
    render(<InteractiveIntroPage />);

    expect(await within(library()).findByRole('alert')).toHaveTextContent(/too quickly/i);
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it('keeps the shown list when a manual refresh fails', async () => {
    listSessions.mockResolvedValueOnce(makePage([makeSummary(1)]));
    listSessions.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<InteractiveIntroPage />);
    await within(library()).findByRole('link', { name: /Continue/ });

    await userEvent.click(within(library()).getByRole('button', { name: 'Refresh' }));

    expect(await within(library()).findByRole('alert')).toHaveTextContent(/out of date/);
    expect(within(library()).getByRole('link', { name: /Continue/ })).toBeInTheDocument();
  });

  describe('pagination', () => {
    const first = [makeSummary(5), makeSummary(4)];
    const second = [makeSummary(3), makeSummary(4)]; // repeats one id on purpose

    it('appends the next page with the server cursor and removes the button on the last page', async () => {
      listSessions.mockResolvedValueOnce(makePage(first, 'cursor-1'));
      listSessions.mockResolvedValueOnce(makePage(second, null));
      render(<InteractiveIntroPage />);
      await within(library()).findAllByRole('listitem');

      await userEvent.click(within(library()).getByRole('button', { name: 'Load more' }));

      await waitFor(() => expect(within(library()).getAllByRole('listitem')).toHaveLength(3));
      expect(listSessions).toHaveBeenLastCalledWith(
        { limit: 20, cursor: 'cursor-1' },
        expect.any(AbortSignal),
      );
      expect(within(library()).queryByRole('button', { name: 'Load more' })).toBeNull();
    });

    it('allows only one pagination request at a time', async () => {
      const gate = deferred<Page>();
      listSessions.mockResolvedValueOnce(makePage(first, 'cursor-1'));
      listSessions.mockReturnValueOnce(gate.promise);
      render(<InteractiveIntroPage />);
      await within(library()).findAllByRole('listitem');

      await userEvent.dblClick(within(library()).getByRole('button', { name: 'Load more' }));

      expect(listSessions).toHaveBeenCalledTimes(2);
      gate.resolve(makePage(second, null));
      await waitFor(() => expect(within(library()).getAllByRole('listitem')).toHaveLength(3));
    });

    it('recovers from a failed page without losing what is shown', async () => {
      listSessions.mockResolvedValueOnce(makePage(first, 'cursor-1'));
      listSessions.mockRejectedValueOnce(new ApiError(503, 'down'));
      listSessions.mockResolvedValueOnce(makePage([makeSummary(3)], null));
      render(<InteractiveIntroPage />);
      await within(library()).findAllByRole('listitem');

      await userEvent.click(within(library()).getByRole('button', { name: 'Load more' }));
      expect(await within(library()).findByRole('alert')).toHaveTextContent(/more stories/i);
      expect(within(library()).getAllByRole('listitem')).toHaveLength(2);
      await userEvent.click(within(library()).getByRole('button', { name: 'Try again' }));

      await waitFor(() => expect(within(library()).getAllByRole('listitem')).toHaveLength(3));
    });

    it('drops a pagination response that a refresh made obsolete', async () => {
      const more = deferred<Page>();
      listSessions.mockResolvedValueOnce(makePage(first, 'cursor-1'));
      listSessions.mockReturnValueOnce(more.promise);
      listSessions.mockResolvedValueOnce(makePage([makeSummary(9)], null));
      render(<InteractiveIntroPage />);
      await within(library()).findAllByRole('listitem');
      await userEvent.click(within(library()).getByRole('button', { name: 'Load more' }));

      await userEvent.click(within(library()).getByRole('button', { name: 'Refresh' }));
      await waitFor(() => expect(within(library()).getAllByRole('listitem')).toHaveLength(1));
      await act(async () => more.resolve(makePage(second, null)));

      // The late page-2 data neither appended nor changed the cursor state.
      expect(within(library()).getAllByRole('listitem')).toHaveLength(1);
      expect(within(library()).queryByRole('button', { name: 'Load more' })).toBeNull();
    });
  });

  describe('scope guards', () => {
    it('never shows another account’s list, even from a response that arrives late', async () => {
      const userOne = deferred<Page>();
      listSessions.mockReturnValueOnce(userOne.promise);
      const { rerender } = render(<InteractiveIntroPage />);

      signInAs('user-2');
      listSessions.mockResolvedValueOnce(
        makePage([makeSummary(2, { sceneTitle: 'User two story' })]),
      );
      rerender(<InteractiveIntroPage />);
      expect(await within(library()).findByText('At: User two story')).toBeInTheDocument();

      await act(async () =>
        userOne.resolve(makePage([makeSummary(1, { sceneTitle: 'User one secret' })])),
      );

      expect(screen.queryByText(/User one secret/)).toBeNull();
      expect(within(library()).getByText('At: User two story')).toBeInTheDocument();
    });

    it('does not render the previous account’s list for even one render after a switch', async () => {
      listSessions.mockResolvedValueOnce(
        makePage([makeSummary(1, { sceneTitle: 'User one story' })]),
      );
      const { rerender } = render(<InteractiveIntroPage />);
      await within(library()).findByText('At: User one story');

      const gate = deferred<Page>();
      listSessions.mockReturnValueOnce(gate.promise);
      signInAs('user-2');
      rerender(<InteractiveIntroPage />);

      expect(screen.queryByText(/User one story/)).toBeNull();
      expect(within(library()).getByRole('status')).toHaveTextContent('Loading your stories');
      await act(async () => gate.resolve(makePage([])));
    });

    it('requests nothing and shows nothing while signed out', () => {
      vi.mocked(useAuth).mockReturnValue({
        status: 'anon',
        user: null,
      } as unknown as ReturnType<typeof useAuth>);
      render(<InteractiveIntroPage />);

      expect(listSessions).not.toHaveBeenCalled();
      expect(within(library()).queryByRole('listitem')).toBeNull();
    });

    it('drops a response that arrives after the auth session changed', async () => {
      const gate = deferred<Page>();
      listSessions.mockReturnValueOnce(gate.promise);
      render(<InteractiveIntroPage />);

      advanceSessionEpoch();
      await act(async () => gate.resolve(makePage([makeSummary(1, { sceneTitle: 'Late story' })])));

      expect(screen.queryByText(/Late story/)).toBeNull();
    });

    it('drops a response that arrives after unmount, and aborts the request', async () => {
      const gate = deferred<Page>();
      let signal: AbortSignal | undefined;
      listSessions.mockImplementationOnce((_params, s) => {
        signal = s;
        return gate.promise;
      });
      const { unmount } = render(<InteractiveIntroPage />);

      unmount();
      expect(signal?.aborted).toBe(true);
      await act(async () => gate.resolve(makePage([makeSummary(1)])));

      expect(screen.queryByText(/Scene of story/)).toBeNull();
    });
  });

  it('keeps double-click protection alongside the library', async () => {
    const gate = deferred<ReturnType<typeof makeView>>();
    listSessions.mockResolvedValue(makePage([]));
    createSession.mockReturnValueOnce(gate.promise);
    render(<InteractiveIntroPage />);
    await within(library()).findByText(/No stories yet/);

    await userEvent.dblClick(await screen.findByRole('button', { name: /^Start story/ }));

    expect(createSession).toHaveBeenCalledTimes(1);
    gate.resolve(makeView(0));
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
  });

  describe('useSessionLibrary (hook level)', () => {
    it('applies only the latest refresh: a slow earlier one cannot regress the list', async () => {
      const slow = deferred<Page>();
      const fast = deferred<Page>();
      listSessions.mockResolvedValueOnce(makePage([makeSummary(1)], null));
      const { result } = renderHook(() => useSessionLibrary());
      await waitFor(() => expect(result.current.phase).toBe('ready'));

      listSessions.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
      act(() => {
        void result.current.refresh(); // older
        void result.current.refresh(); // newer: supersedes the older
      });
      await act(async () => fast.resolve(makePage([makeSummary(7), makeSummary(6)], null)));
      expect(result.current.sessions.map((s) => s.sceneTitle)).toEqual([
        'Scene of story 7',
        'Scene of story 6',
      ]);

      await act(async () => slow.resolve(makePage([makeSummary(2)], null)));

      expect(result.current.sessions.map((s) => s.sceneTitle)).toEqual([
        'Scene of story 7',
        'Scene of story 6',
      ]);
      expect(result.current.refreshing).toBe(false);
    });

    it('never starts a second pagination request while one is pending', async () => {
      const gate = deferred<Page>();
      listSessions.mockResolvedValueOnce(makePage([makeSummary(5)], 'cursor-1'));
      const { result } = renderHook(() => useSessionLibrary());
      await waitFor(() => expect(result.current.phase).toBe('ready'));

      listSessions.mockReturnValueOnce(gate.promise);
      act(() => {
        void result.current.loadMore();
        void result.current.loadMore();
      });

      expect(listSessions).toHaveBeenCalledTimes(2); // first page + exactly one next page
      await act(async () => gate.resolve(makePage([makeSummary(4)], null)));
      expect(result.current.sessions).toHaveLength(2);
    });
  });
});
