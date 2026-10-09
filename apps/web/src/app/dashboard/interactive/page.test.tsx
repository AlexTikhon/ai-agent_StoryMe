import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { advanceSessionEpoch } from '@/lib/auth/token-store';
import { SESSION_ID, deferred, makePage, makeView } from './interactive-test-fixtures';
import InteractiveIntroPage from './page';

vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));
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
    listSessions: vi.fn(),
    getSession: vi.fn(),
    submitChoice: vi.fn(),
  },
}));

const createSession = vi.mocked(interactiveApi.createSession);
const listSessions = vi.mocked(interactiveApi.listSessions);
const pushMock = vi.fn();

beforeEach(() => {
  vi.mocked(useRouter).mockReturnValue({ push: pushMock } as unknown as ReturnType<
    typeof useRouter
  >);
  vi.mocked(useAuth).mockReturnValue({
    status: 'authed',
    user: { id: 'user-1' },
  } as unknown as ReturnType<typeof useAuth>);
  createSession.mockReset();
  listSessions.mockReset();
  listSessions.mockResolvedValue(makePage([]));
  pushMock.mockReset();
});

describe('interactive intro page', () => {
  it('introduces the story and does not create a session on mount', async () => {
    render(<InteractiveIntroPage />);
    await screen.findByText(/No stories yet/);

    expect(screen.getByRole('heading', { name: 'The Last Delivery' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start story' })).toBeEnabled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('creates exactly one session for a double click, then opens its reader URL', async () => {
    const gate = deferred<ReturnType<typeof makeView>>();
    createSession.mockReturnValueOnce(gate.promise);
    render(<InteractiveIntroPage />);

    await userEvent.dblClick(screen.getByRole('button', { name: 'Start story' }));

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(
      {
        scenarioId: 'warsaw-last-delivery',
        idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
      expect.any(AbortSignal),
    );
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();

    gate.resolve(makeView(0));
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(`/dashboard/interactive/${SESSION_ID}`),
    );
  });

  it('keeps one creation command through a manual retry after an ambiguous failure', async () => {
    createSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    createSession.mockResolvedValueOnce(makeView(0));
    render(<InteractiveIntroPage />);

    await userEvent.click(screen.getByRole('button', { name: 'Start story' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/won.t start a second story/i);
    // Never retried automatically.
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(pushMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(`/dashboard/interactive/${SESSION_ID}`),
    );
    expect(createSession).toHaveBeenCalledTimes(2);
    const [first, second] = createSession.mock.calls.map(([command]) => command);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first)); // same body, same key
  });

  it('mints a new command for the next deliberate start after a definitive rejection', async () => {
    createSession.mockRejectedValueOnce(new ApiError(422, 'nope', 'UNKNOWN_SCENARIO'));
    createSession.mockResolvedValueOnce(makeView(0));
    render(<InteractiveIntroPage />);

    await userEvent.click(screen.getByRole('button', { name: 'Start story' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t be started/i);
    await userEvent.click(screen.getByRole('button', { name: 'Start story' }));
    await waitFor(() => expect(pushMock).toHaveBeenCalled());

    const [first, second] = createSession.mock.calls.map(([command]) => command);
    expect(second!.idempotencyKey).not.toBe(first!.idempotencyKey);
  });

  it('explains the session limit, does not retry, and offers a fresh start', async () => {
    createSession.mockRejectedValueOnce(new ApiError(409, 'limit', 'SESSION_LIMIT_REACHED'));
    render(<InteractiveIntroPage />);

    await userEvent.click(screen.getByRole('button', { name: 'Start story' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/maximum number of stories/i);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start story' })).toBeEnabled();
  });

  it('explains a rate limit, never retries by itself, and resends the same command on request', async () => {
    createSession.mockRejectedValueOnce(new ApiError(429, 'HTTP 429', 'RATE_LIMITED'));
    createSession.mockResolvedValueOnce(makeView(0));
    render(<InteractiveIntroPage />);

    await userEvent.click(screen.getByRole('button', { name: 'Start story' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/too quickly/i);
    expect(createSession).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    expect(createSession.mock.calls[1]![0]).toEqual(createSession.mock.calls[0]![0]);
  });

  it('drops the held command when the page unmounts, so a new visit starts fresh', async () => {
    createSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const first = render(<InteractiveIntroPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Start story' }));
    await screen.findByRole('alert');
    first.unmount();

    createSession.mockResolvedValueOnce(makeView(0));
    render(<InteractiveIntroPage />);
    expect(screen.getByRole('button', { name: 'Start story' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Start story' }));
    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    expect(createSession.mock.calls[1]![0].idempotencyKey).not.toBe(
      createSession.mock.calls[0]![0].idempotencyKey,
    );
  });

  it('shows a calm message for a server error', async () => {
    createSession.mockRejectedValueOnce(new ApiError(503, 'down'));
    render(<InteractiveIntroPage />);

    await userEvent.click(screen.getByRole('button', { name: 'Start story' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/second story|trouble/i);
  });

  it('does not navigate when the page unmounts before creation finishes', async () => {
    const gate = deferred<ReturnType<typeof makeView>>();
    createSession.mockReturnValueOnce(gate.promise);
    const { unmount } = render(<InteractiveIntroPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Start story' }));

    unmount();
    gate.resolve(makeView(0));
    await Promise.resolve();

    expect(pushMock).not.toHaveBeenCalled();
  });

  it('does not navigate when the auth session changed during creation', async () => {
    const gate = deferred<ReturnType<typeof makeView>>();
    createSession.mockReturnValueOnce(gate.promise);
    render(<InteractiveIntroPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Start story' }));

    advanceSessionEpoch();
    gate.resolve(makeView(0));
    await Promise.resolve();
    await Promise.resolve();

    expect(pushMock).not.toHaveBeenCalled();
  });
});
