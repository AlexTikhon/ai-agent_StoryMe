import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useParams, useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { SESSION_ID, deferred, makeView } from '../interactive-test-fixtures';
import InteractiveReaderPage from './page';

vi.mock('next/navigation', () => ({ useParams: vi.fn(), useRouter: vi.fn() }));
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
    createSession: vi.fn(),
    getSession: vi.fn(),
    submitChoice: vi.fn(),
    // Illustrations are covered in scene-illustration.test.tsx; here they never arrive.
    getPresentation: vi.fn(() => new Promise(() => {})),
  },
}));

const getSession = vi.mocked(interactiveApi.getSession);
const submitChoice = vi.mocked(interactiveApi.submitChoice);
const createSession = vi.mocked(interactiveApi.createSession);
const pushMock = vi.fn();

beforeEach(() => {
  vi.mocked(useParams).mockReturnValue({ sessionId: SESSION_ID });
  vi.mocked(useRouter).mockReturnValue({ push: pushMock } as unknown as ReturnType<
    typeof useRouter
  >);
  vi.mocked(useAuth).mockReturnValue({
    status: 'authed',
    user: { id: 'user-1' },
  } as unknown as ReturnType<typeof useAuth>);
  getSession.mockReset();
  submitChoice.mockReset();
  createSession.mockReset();
  pushMock.mockReset();
});

describe('interactive reader page', () => {
  it('shows a loading state, then the scene, narration, choices, clues and items', async () => {
    const gate = deferred<ReturnType<typeof makeView>>();
    getSession.mockReturnValueOnce(gate.promise);
    render(<InteractiveReaderPage />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading your story');

    gate.resolve(
      makeView(2, {
        scene: { id: 's-door', title: 'Flat 4' },
        narration: 'First paragraph.\n\nSecond paragraph.',
        choices: [
          { id: 'c-1', label: 'Knock' },
          { id: 'c-2', label: 'Leave' },
        ],
        player: {
          knowledge: [{ id: 'f-1', text: 'Tomasz has been gone two days.' }],
          inventory: [{ id: 'i-1', name: 'Entry card' }],
        },
      }),
    );

    expect(await screen.findByRole('heading', { name: 'Flat 4' })).toBeInTheDocument();
    expect(screen.getByText('First paragraph.')).toBeInTheDocument();
    expect(screen.getByText('Second paragraph.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Knock' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Leave' })).toBeEnabled();
    const clues = screen.getByRole('region', { name: 'Clues' });
    expect(within(clues).getByText('Tomasz has been gone two days.')).toBeInTheDocument();
    const items = screen.getByRole('region', { name: 'Carrying' });
    expect(within(items).getByText('Entry card')).toBeInTheDocument();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('renders narration as plain text, never as HTML', async () => {
    getSession.mockResolvedValueOnce(
      makeView(0, { narration: '<img src=x onerror="alert(1)"> **bold** <b>tag</b>' }),
    );
    const { container } = render(<InteractiveReaderPage />);

    expect(await screen.findByText(/onerror/)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText(/\*\*bold\*\*/)).toBeInTheDocument();
  });

  it('treats a single-option transition as an ordinary server-provided choice', async () => {
    getSession.mockResolvedValueOnce(
      makeView(1, { choices: [{ id: 'c-climb', label: 'Climb to the fourth floor' }] }),
    );
    render(<InteractiveReaderPage />);

    const button = await screen.findByRole('button', { name: 'Climb to the fourth floor' });
    submitChoice.mockResolvedValueOnce(makeView(2));
    await userEvent.click(button);

    expect(submitChoice).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ choiceId: 'c-climb', expectedRevision: 1 }),
      expect.anything(),
    );
    expect(await screen.findByRole('heading', { name: 'Scene 2' })).toBeInTheDocument();
  });

  it('disables choices and sends exactly one request for a double click', async () => {
    getSession.mockResolvedValueOnce(makeView(0));
    render(<InteractiveReaderPage />);
    const button = await screen.findByRole('button', { name: 'Choice A' });
    const gate = deferred<ReturnType<typeof makeView>>();
    submitChoice.mockReturnValueOnce(gate.promise);

    await userEvent.dblClick(button);

    expect(submitChoice).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Choice A' })).toBeDisabled();
    expect(screen.getByText('Sending your choice…')).toBeInTheDocument();
    // Still the old scene: nothing advanced optimistically.
    expect(screen.getByRole('heading', { name: 'Scene 0' })).toBeInTheDocument();

    gate.resolve(makeView(1));
    expect(await screen.findByRole('heading', { name: 'Scene 1' })).toBeInTheDocument();
  });

  it('retry after a lost response sends the identical command', async () => {
    getSession.mockResolvedValueOnce(makeView(0));
    submitChoice.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<InteractiveReaderPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Choice A' }));
    const retry = await screen.findByRole('button', { name: 'Retry choice' });

    submitChoice.mockResolvedValueOnce(makeView(1));
    getSession.mockResolvedValueOnce(makeView(1));
    await userEvent.click(retry);

    expect(await screen.findByRole('heading', { name: 'Scene 1' })).toBeInTheDocument();
    expect(submitChoice.mock.calls[1]![1]).toEqual(submitChoice.mock.calls[0]![1]);
    expect(screen.queryByRole('button', { name: 'Retry choice' })).toBeNull();
  });

  it('explains a revision conflict, reloads, and waits for a fresh user action', async () => {
    getSession.mockResolvedValueOnce(makeView(0));
    render(<InteractiveReaderPage />);
    submitChoice.mockRejectedValueOnce(new ApiError(409, 'moved', 'REVISION_CONFLICT'));
    getSession.mockResolvedValueOnce(makeView(3, { choices: [{ id: 'c-b', label: 'Choice B' }] }));

    await userEvent.click(await screen.findByRole('button', { name: 'Choice A' }));

    expect(await screen.findByRole('button', { name: 'Choice B' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent(/moved on/i);
    expect(submitChoice).toHaveBeenCalledTimes(1);
  });

  it('shows the ending with a “Start another story” link to the catalogue, creating nothing', async () => {
    getSession.mockResolvedValueOnce(
      makeView(5, {
        status: 'ended',
        choices: [],
        ending: {
          id: 'quiet-delivery',
          title: 'A Quiet Delivery',
          summary: 'The parcel was delivered.',
        },
      }),
    );
    render(<InteractiveReaderPage />);

    expect(await screen.findByRole('heading', { name: 'A Quiet Delivery' })).toBeInTheDocument();
    expect(screen.getByText('The parcel was delivered.')).toBeInTheDocument();
    expect(screen.queryByText('What do you do?')).toBeNull();
    // Not created until asked.
    expect(createSession).not.toHaveBeenCalled();

    // The reader never picks a story: the user chooses one from the server catalogue.
    const another = screen.getByRole('link', { name: 'Start another story' });
    expect(another).toHaveAttribute('href', '/dashboard/interactive');
    expect(screen.queryByRole('button', { name: 'Start another story' })).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('shows the same unavailable screen for missing and foreign sessions', async () => {
    getSession.mockRejectedValueOnce(new ApiError(404, 'Session not found', 'SESSION_NOT_FOUND'));
    const first = render(<InteractiveReaderPage />);
    const missingHtml = (await screen.findByRole('heading', { name: /isn.t available/ }))
      .parentElement!.innerHTML;
    first.unmount();

    getSession.mockRejectedValueOnce(new ApiError(404, 'Session not found', 'SESSION_NOT_FOUND'));
    render(<InteractiveReaderPage />);
    const foreignHtml = (await screen.findByRole('heading', { name: /isn.t available/ }))
      .parentElement!.innerHTML;

    expect(foreignHtml).toBe(missingHtml);
    expect(screen.queryByRole('button', { name: /choice/i })).toBeNull();
  });

  it('lets the user retry a failed load', async () => {
    getSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<InteractiveReaderPage />);
    const retry = await screen.findByRole('button', { name: 'Try again' });

    getSession.mockResolvedValueOnce(makeView(0));
    await userEvent.click(retry);

    expect(await screen.findByRole('heading', { name: 'Scene 0' })).toBeInTheDocument();
  });
});
