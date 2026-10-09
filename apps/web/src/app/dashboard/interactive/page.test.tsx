import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { advanceSessionEpoch } from '@/lib/auth/token-store';
import { SESSION_ID, deferred, makeView } from './interactive-test-fixtures';
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
  interactiveApi: { createSession: vi.fn(), getSession: vi.fn(), submitChoice: vi.fn() },
}));

const createSession = vi.mocked(interactiveApi.createSession);
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
  pushMock.mockReset();
});

describe('interactive intro page', () => {
  it('introduces the story and does not create a session on mount', () => {
    render(<InteractiveIntroPage />);

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
    expect(createSession).toHaveBeenCalledWith('warsaw-last-delivery', expect.any(AbortSignal));
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();

    gate.resolve(makeView(0));
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(`/dashboard/interactive/${SESSION_ID}`),
    );
  });

  it('reports an ambiguous failure without retrying, and warns that a repeat may duplicate', async () => {
    createSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<InteractiveIntroPage />);

    await userEvent.click(screen.getByRole('button', { name: 'Start story' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/second story/i);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start story' })).toBeEnabled();
  });

  it('shows a calm message for a server error', async () => {
    createSession.mockRejectedValueOnce(new ApiError(503, 'down'));
    render(<InteractiveIntroPage />);

    await userEvent.click(screen.getByRole('button', { name: 'Start story' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/trouble/i);
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
