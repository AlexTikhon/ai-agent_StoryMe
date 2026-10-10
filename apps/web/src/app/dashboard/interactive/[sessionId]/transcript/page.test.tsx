import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useParams } from 'next/navigation';
import type { InteractiveTranscriptDto } from '@book/types';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import {
  SESSION_ID,
  deferred,
  makeMetadata,
  makeTranscriptPage,
  makeTranscriptStep,
} from '../../interactive-test-fixtures';
import InteractiveTranscriptPage from './page';

vi.mock('next/navigation', () => ({ useParams: vi.fn() }));
vi.mock('next/link', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, className }: any) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: vi.fn() }));
vi.mock('@/lib/api/interactive', () => ({
  interactiveApi: {
    getTranscript: vi.fn(),
    getSessionMetadata: vi.fn(),
    createSession: vi.fn(),
    submitChoice: vi.fn(),
    getSession: vi.fn(),
    getPresentation: vi.fn(),
  },
}));

const getTranscript = vi.mocked(interactiveApi.getTranscript);
const getSessionMetadata = vi.mocked(interactiveApi.getSessionMetadata);
const createSession = vi.mocked(interactiveApi.createSession);
const submitChoice = vi.mocked(interactiveApi.submitChoice);
const getPresentation = vi.mocked(interactiveApi.getPresentation);

const page1 = () => makeTranscriptPage(0, 2, 6);
const page2 = () => makeTranscriptPage(3, 5, 6);
const page3 = () => makeTranscriptPage(6, 6, 6);

const progress = () => screen.getByTestId('transcript-progress');
const chapters = () => screen.getAllByTestId('transcript-chapter');

beforeEach(() => {
  vi.mocked(useParams).mockReturnValue({ sessionId: SESSION_ID });
  vi.mocked(useAuth).mockReturnValue({
    status: 'authed',
    user: { id: 'user-1' },
  } as unknown as ReturnType<typeof useAuth>);
  for (const fn of [getTranscript, createSession, submitChoice, getPresentation]) fn.mockReset();
  getSessionMetadata.mockReset();
  getSessionMetadata.mockImplementation(() => new Promise(() => {}));
});

describe('interactive transcript page', () => {
  it('shows a loading state, then the first three chapters with a Load more button', async () => {
    const gate = deferred<InteractiveTranscriptDto>();
    getTranscript.mockReturnValueOnce(gate.promise);
    render(<InteractiveTranscriptPage />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading the story');

    gate.resolve(page1());
    expect(await screen.findByRole('heading', { name: 'Scene 0' })).toBeInTheDocument();
    expect(chapters()).toHaveLength(3);
    expect(screen.getByRole('heading', { name: 'Scene 2' })).toBeInTheDocument();
    expect(screen.getByText('Narration for revision 1.')).toBeInTheDocument();
    expect(screen.getByText('You chose: Choice into 1')).toBeInTheDocument();
    expect(screen.queryByText(/You chose: .*0$/)).toBeNull(); // the opening has no arrival
    expect(progress()).toHaveTextContent('Showing 3 of 7 chapters');
    expect(progress()).not.toHaveTextContent(/all/i);
    expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled();
    // Partial history shows no ending and no "start another" completion actions.
    expect(screen.queryByText('The end')).toBeNull();
    expect(getTranscript).toHaveBeenCalledTimes(1);
    expect(createSession).not.toHaveBeenCalled();
    expect(submitChoice).not.toHaveBeenCalled();
    expect(getPresentation).not.toHaveBeenCalled(); // no artwork for historical steps
  });

  it('loads the remaining pages chronologically and finishes with the ending', async () => {
    const user = userEvent.setup();
    getTranscript.mockResolvedValueOnce(page1());
    render(<InteractiveTranscriptPage />);
    await screen.findByRole('heading', { name: 'Scene 0' });

    getTranscript.mockResolvedValueOnce(page2());
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByRole('heading', { name: 'Scene 5' });
    expect(chapters()).toHaveLength(6);
    expect(progress()).toHaveTextContent('Showing 6 of 7 chapters');

    getTranscript.mockResolvedValueOnce(page3());
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByRole('heading', { name: 'A Quiet Delivery' });

    expect(chapters()).toHaveLength(7);
    expect(chapters().map((c) => within(c).getByRole('heading', { level: 2 }).textContent)).toEqual(
      ['Scene 0', 'Scene 1', 'Scene 2', 'Scene 3', 'Scene 4', 'Scene 5', 'Scene 6'],
    );
    expect(screen.getByText('The parcel is delivered.')).toBeInTheDocument();
    expect(progress()).toHaveTextContent('All 7 chapters');
    expect(screen.queryByRole('button', { name: /Load more|Try again/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to the ending' })).toHaveAttribute(
      'href',
      `/dashboard/interactive/${SESSION_ID}`,
    );
    expect(screen.getByRole('link', { name: 'Start another story' })).toHaveAttribute(
      'href',
      '/dashboard/interactive',
    );
    expect(getTranscript).toHaveBeenCalledTimes(3);
    expect(createSession).not.toHaveBeenCalled();
    expect(submitChoice).not.toHaveBeenCalled();
  });

  it('moves focus to the first new chapter after Load more', async () => {
    const user = userEvent.setup();
    getTranscript.mockResolvedValueOnce(page1());
    render(<InteractiveTranscriptPage />);
    await screen.findByRole('heading', { name: 'Scene 0' });

    getTranscript.mockResolvedValueOnce(page2());
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    const heading = await screen.findByRole('heading', { name: 'Scene 3' });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('renders a second ending exactly as the server sent it', async () => {
    getTranscript.mockResolvedValueOnce({
      ...makeTranscriptPage(0, 1, 1),
      steps: [
        makeTranscriptStep(0, 1),
        makeTranscriptStep(1, 1, {
          scene: { id: 's-exposed', title: 'The ledger exposed' },
          ending: { title: 'The Ledger Exposed', summary: 'Ines is named.' },
        }),
      ],
    });
    render(<InteractiveTranscriptPage />);

    expect(await screen.findByRole('heading', { name: 'The Ledger Exposed' })).toBeInTheDocument();
    expect(screen.getByText('Ines is named.')).toBeInTheDocument();
    expect(progress()).toHaveTextContent('All 2 chapters');
  });

  it('renders authored text as escaped plain text, never as markup', async () => {
    const hostile = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
    getTranscript.mockResolvedValueOnce({
      ...makeTranscriptPage(0, 1, 1),
      steps: [
        makeTranscriptStep(0, 1, {
          scene: { id: 's0', title: `Title ${hostile}` },
          narration: `Line ${hostile}\n\nSecond ${hostile}`,
        }),
        makeTranscriptStep(1, 1, {
          arrivedByChoiceLabel: `Choice ${hostile}`,
          ending: { title: `End ${hostile}`, summary: `Summary ${hostile}` },
        }),
      ],
    });
    const { container } = render(<InteractiveTranscriptPage />);

    expect(await screen.findByText(`Title ${hostile}`)).toBeInTheDocument();
    expect(screen.getByText(`Line ${hostile}`)).toBeInTheDocument();
    expect(screen.getByText(`You chose: Choice ${hostile}`)).toBeInTheDocument();
    expect(screen.getByText(`End ${hostile}`)).toBeInTheDocument();
    expect(screen.getByText(`Summary ${hostile}`)).toBeInTheDocument();
    expect(container.querySelector('main img, main b')).toBeNull();
    expect((window as unknown as Record<string, unknown>)['__pwned']).toBeUndefined();
  });

  describe('story title', () => {
    it('uses the pinned version title from the metadata endpoint', async () => {
      getTranscript.mockResolvedValueOnce(page1());
      getSessionMetadata.mockResolvedValueOnce(makeMetadata({ title: 'The Last Delivery' }));
      render(<InteractiveTranscriptPage />);

      await waitFor(() =>
        expect(screen.getByTestId('story-title')).toHaveTextContent('The Last Delivery'),
      );
      expect(getSessionMetadata).toHaveBeenCalledWith(SESSION_ID, expect.any(AbortSignal));
    });

    it('falls back to a generic title when metadata fails, without affecting the chapters', async () => {
      getTranscript.mockResolvedValueOnce(page1());
      getSessionMetadata.mockRejectedValueOnce(new ApiError(503, 'down', 'SERVICE_UNAVAILABLE'));
      render(<InteractiveTranscriptPage />);

      await screen.findByRole('heading', { name: 'Scene 0' });
      await waitFor(() => expect(getSessionMetadata).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId('story-title')).toHaveTextContent('Interactive story');
      expect(chapters()).toHaveLength(3);
      expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled();
    });

    it('does not request metadata before the pinned version is known', async () => {
      getTranscript.mockReturnValueOnce(new Promise(() => {}));
      render(<InteractiveTranscriptPage />);
      await screen.findByRole('status');
      expect(getSessionMetadata).not.toHaveBeenCalled();
    });
  });

  describe('failures', () => {
    it('offers a retry after an initial failure and loads the first page', async () => {
      const user = userEvent.setup();
      getTranscript.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      render(<InteractiveTranscriptPage />);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("We couldn't load this story");
      expect(screen.queryByTestId('transcript-chapter')).toBeNull();

      getTranscript.mockResolvedValueOnce(page1());
      await user.click(within(alert).getByRole('button', { name: 'Try again' }));
      await screen.findByRole('heading', { name: 'Scene 0' });
      expect(getTranscript.mock.calls[1]![1]).toEqual({ limit: 3, cursor: null });
    });

    it('keeps loaded chapters after a later failure, never calls them complete, and retries the exact cursor', async () => {
      const user = userEvent.setup();
      getTranscript.mockResolvedValueOnce(page1());
      render(<InteractiveTranscriptPage />);
      await screen.findByRole('heading', { name: 'Scene 0' });

      getTranscript.mockRejectedValueOnce(new ApiError(503, 'down', 'SERVICE_UNAVAILABLE'));
      await user.click(screen.getByRole('button', { name: 'Load more' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("We couldn't load the next chapters");
      expect(chapters()).toHaveLength(3);
      expect(progress()).toHaveTextContent('Showing 3 of 7 chapters');
      expect(progress()).not.toHaveTextContent(/all/i);

      getTranscript.mockResolvedValueOnce(page2());
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      await screen.findByRole('heading', { name: 'Scene 5' });
      expect(screen.queryByRole('alert')).toBeNull();
      expect(getTranscript.mock.calls[1]![1]).toEqual({ limit: 3, cursor: 'cursor-3' });
      expect(getTranscript.mock.calls[2]![1]).toEqual({ limit: 3, cursor: 'cursor-3' });
    });

    it('explains a rate limit and keeps the chapters', async () => {
      const user = userEvent.setup();
      getTranscript.mockResolvedValueOnce(page1());
      render(<InteractiveTranscriptPage />);
      await screen.findByRole('heading', { name: 'Scene 0' });

      getTranscript.mockRejectedValueOnce(new ApiError(429, 'slow down', 'RATE_LIMITED'));
      await user.click(screen.getByRole('button', { name: 'Load more' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/too quickly/i);
      expect(chapters()).toHaveLength(3);
      expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    });

    it('rejects an inconsistent page visibly and leaves the history unchanged', async () => {
      const user = userEvent.setup();
      getTranscript.mockResolvedValueOnce(page1());
      render(<InteractiveTranscriptPage />);
      await screen.findByRole('heading', { name: 'Scene 0' });

      // Revision 3 is skipped.
      getTranscript.mockResolvedValueOnce(makeTranscriptPage(4, 6, 6));
      await user.click(screen.getByRole('button', { name: 'Load more' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/didn't match what you've read/);
      expect(chapters()).toHaveLength(3);
      expect(screen.queryByRole('heading', { name: 'Scene 4' })).toBeNull();
      expect(progress()).not.toHaveTextContent(/all/i);
    });

    it('shows nothing for an inconsistent first page', async () => {
      getTranscript.mockResolvedValueOnce({ ...page1(), sessionId: 'someone-else' });
      render(<InteractiveTranscriptPage />);
      expect(await screen.findByRole('alert')).toHaveTextContent(/didn't load correctly/);
      expect(screen.queryByTestId('transcript-chapter')).toBeNull();
    });

    it('sends one request when Load more is clicked repeatedly', async () => {
      const user = userEvent.setup();
      getTranscript.mockResolvedValueOnce(page1());
      render(<InteractiveTranscriptPage />);
      await screen.findByRole('heading', { name: 'Scene 0' });

      const gate = deferred<InteractiveTranscriptDto>();
      getTranscript.mockReturnValueOnce(gate.promise);
      const button = screen.getByRole('button', { name: 'Load more' });
      await user.dblClick(button);
      await user.click(button);
      expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled();
      expect(getTranscript).toHaveBeenCalledTimes(2);

      gate.resolve(page2());
      await screen.findByRole('heading', { name: 'Scene 5' });
      expect(chapters()).toHaveLength(6);
    });

    it('shows the same unavailable screen for missing and foreign sessions', async () => {
      getTranscript.mockRejectedValueOnce(new ApiError(404, 'nope', 'SESSION_NOT_FOUND'));
      render(<InteractiveTranscriptPage />);
      expect(await screen.findByRole('heading', { name: /isn.t available/ })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Go to the story page' })).toHaveAttribute(
        'href',
        '/dashboard/interactive',
      );
      expect(screen.queryByTestId('transcript-chapter')).toBeNull();
    });

    it('explains that rereading follows completion and links to the existing reader', async () => {
      getTranscript.mockRejectedValueOnce(new ApiError(409, 'not done', 'SESSION_NOT_COMPLETED'));
      render(<InteractiveTranscriptPage />);

      expect(
        await screen.findByRole('heading', { name: 'Rereading comes after the ending' }),
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Continue the story' })).toHaveAttribute(
        'href',
        `/dashboard/interactive/${SESSION_ID}`,
      );
      expect(screen.queryByRole('button')).toBeNull();
    });

    it('leaves authentication failures to the shared auth handling', async () => {
      getTranscript.mockRejectedValueOnce(new ApiError(401, 'expired', 'UNAUTHORIZED'));
      render(<InteractiveTranscriptPage />);
      expect(await screen.findByRole('alert')).toHaveTextContent(/sign in again/i);
      expect(screen.queryByTestId('transcript-chapter')).toBeNull();
    });
  });

  describe('stale responses', () => {
    it('never shows the previous session’s chapters under the next session', async () => {
      const OTHER = '9b2f1c52-7a41-4c7e-8a55-1f0d9d0c7b10';
      const old = deferred<InteractiveTranscriptDto>();
      const next = deferred<InteractiveTranscriptDto>();
      getTranscript.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
      const { rerender } = render(<InteractiveTranscriptPage />);

      vi.mocked(useParams).mockReturnValue({ sessionId: OTHER });
      rerender(<InteractiveTranscriptPage />);
      expect(screen.getByRole('status')).toHaveTextContent('Loading the story');

      // The abandoned session's answer arrives late and is ignored.
      old.resolve(page1());
      await Promise.resolve();
      expect(screen.queryByTestId('transcript-chapter')).toBeNull();

      next.resolve({
        ...makeTranscriptPage(0, 0, 0, { sessionId: OTHER }),
        steps: [makeTranscriptStep(0, 0, { scene: { id: 'o', title: 'Other story' } })],
      });
      expect(await screen.findByRole('heading', { name: 'Other story' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Scene 0' })).toBeNull();
      expect(getTranscript.mock.calls[1]![0]).toBe(OTHER);
    });
  });
});
