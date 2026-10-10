import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { advanceSessionEpoch } from '@/lib/auth/token-store';
import {
  SESSION_ID,
  deferred,
  makeCatalogue,
  makeCatalogueEntry,
  makePage,
  makeSummary,
  makeView,
} from './interactive-test-fixtures';
import InteractiveIntroPage from './page';

vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));
vi.mock('next/link', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, className, ...rest }: any) => (
    <a href={href} className={className} {...rest}>
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

const DELIVERY = makeCatalogueEntry();
const TRAM_FIXTURE = makeCatalogueEntry({
  scenarioId: 'test-second-story',
  scenarioVersion: 3,
  title: 'The Second Test Story',
  synopsis: 'A different, test-only synopsis.',
});

/** The "Start story" button of the card titled `title`. */
const startButton = (title: string) =>
  screen.getByRole('button', { name: `Start story: ${title}` });

async function renderReady() {
  render(<InteractiveIntroPage />);
  await screen.findAllByRole('button', { name: /^Start story: / });
}

beforeEach(() => {
  vi.mocked(useRouter).mockReturnValue({ push: pushMock } as unknown as ReturnType<
    typeof useRouter
  >);
  vi.mocked(useAuth).mockReturnValue({
    status: 'authed',
    user: { id: 'user-1' },
  } as unknown as ReturnType<typeof useAuth>);
  listScenarios.mockReset();
  listScenarios.mockResolvedValue(makeCatalogue(DELIVERY));
  createSession.mockReset();
  listSessions.mockReset();
  listSessions.mockResolvedValue(makePage([]));
  pushMock.mockReset();
});

describe('interactive intro page: catalogue', () => {
  it('renders one accessible card per catalogue entry with the server title and synopsis', async () => {
    listScenarios.mockResolvedValue(makeCatalogue(DELIVERY, TRAM_FIXTURE));
    await renderReady();

    const list = screen.getByRole('list', { name: 'Available stories' });
    const cards = within(list).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByRole('heading', { name: 'The Last Delivery' })).toBeVisible();
    expect(within(cards[0]!).getByText(DELIVERY.synopsis)).toBeVisible();
    expect(within(cards[1]!).getByRole('heading', { name: 'The Second Test Story' })).toBeVisible();
    expect(within(cards[1]!).getByText(TRAM_FIXTURE.synopsis)).toBeVisible();
  });

  it('shows a loading state, and does not create a session on mount', async () => {
    const gate = deferred<ReturnType<typeof makeCatalogue>>();
    listScenarios.mockReturnValueOnce(gate.promise);
    render(<InteractiveIntroPage />);

    expect(screen.getByText('Loading stories…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Start story/ })).not.toBeInTheDocument();

    gate.resolve(makeCatalogue(DELIVERY));
    await screen.findByRole('button', { name: /^Start story: / });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('shows an empty state when no stories are published', async () => {
    listScenarios.mockResolvedValue({ scenarios: [] });
    render(<InteractiveIntroPage />);

    expect(await screen.findByText(/No stories are available right now/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Start story/ })).not.toBeInTheDocument();
  });

  it('shows an error with a manual retry, and never retries by itself', async () => {
    listScenarios.mockRejectedValueOnce(new ApiError(503, 'down'));
    listScenarios.mockResolvedValueOnce(makeCatalogue(DELIVERY));
    render(<InteractiveIntroPage />);

    const alert = await screen.findByText(/couldn.t load the available stories/i);
    expect(alert).toBeInTheDocument();
    expect(listScenarios).toHaveBeenCalledTimes(1);

    const retry = screen.getAllByRole('button', { name: 'Try again' })[0]!;
    await userEvent.click(retry);

    await screen.findByRole('button', { name: 'Start story: The Last Delivery' });
    expect(listScenarios).toHaveBeenCalledTimes(2);
  });

  it('keeps the session library usable when the catalogue fails', async () => {
    listScenarios.mockRejectedValue(new ApiError(500, 'boom'));
    listSessions.mockResolvedValue(makePage([makeSummary(1)]));
    render(<InteractiveIntroPage />);

    await screen.findByText(/couldn.t load the available stories/i);
    const link = await screen.findByRole('link', { name: /Continue The Last Delivery/ });
    expect(link).toHaveAttribute(
      'href',
      '/dashboard/interactive/00000000-0000-4000-8000-000000000001',
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it('does not show another account’s catalogue request result after an auth change', async () => {
    const gate = deferred<ReturnType<typeof makeCatalogue>>();
    listScenarios.mockReturnValueOnce(gate.promise);
    render(<InteractiveIntroPage />);

    advanceSessionEpoch();
    gate.resolve(makeCatalogue(DELIVERY));
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByRole('button', { name: /^Start story/ })).not.toBeInTheDocument();
  });
});

describe('interactive intro page: starting a story', () => {
  it('creates a session only on a deliberate click, with the card’s id, version and one key', async () => {
    const gate = deferred<ReturnType<typeof makeView>>();
    createSession.mockReturnValueOnce(gate.promise);
    listScenarios.mockResolvedValue(makeCatalogue(DELIVERY, TRAM_FIXTURE));
    await renderReady();
    expect(createSession).not.toHaveBeenCalled();

    await userEvent.click(startButton('The Second Test Story'));

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(
      {
        scenarioId: 'test-second-story',
        scenarioVersion: 3,
        idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
      expect.any(AbortSignal),
    );
    gate.resolve(makeView(0));
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(`/dashboard/interactive/${SESSION_ID}`),
    );
  });

  it('creates exactly one session for a double click, then opens its reader URL', async () => {
    const gate = deferred<ReturnType<typeof makeView>>();
    createSession.mockReturnValueOnce(gate.promise);
    await renderReady();

    await userEvent.dblClick(startButton('The Last Delivery'));

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();

    gate.resolve(makeView(0));
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(`/dashboard/interactive/${SESSION_ID}`),
    );
  });

  it('disables every other card while a start is in flight', async () => {
    const gate = deferred<ReturnType<typeof makeView>>();
    createSession.mockReturnValueOnce(gate.promise);
    listScenarios.mockResolvedValue(makeCatalogue(DELIVERY, TRAM_FIXTURE));
    await renderReady();

    await userEvent.click(startButton('The Last Delivery'));
    expect(startButton('The Second Test Story')).toBeDisabled();
    await userEvent.click(startButton('The Second Test Story'));

    expect(createSession).toHaveBeenCalledTimes(1);
    gate.resolve(makeView(0));
    await waitFor(() => expect(pushMock).toHaveBeenCalled());
  });

  it('keeps one command through a manual retry after an ambiguous failure, blocking other cards', async () => {
    createSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    createSession.mockResolvedValueOnce(makeView(0));
    listScenarios.mockResolvedValue(makeCatalogue(DELIVERY, TRAM_FIXTURE));
    await renderReady();

    await userEvent.click(startButton('The Last Delivery'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/won.t start a second story/i);
    expect(createSession).toHaveBeenCalledTimes(1); // never retried automatically
    expect(pushMock).not.toHaveBeenCalled();
    // Unresolved: no card can start another story.
    expect(startButton('The Last Delivery')).toBeDisabled();
    expect(startButton('The Second Test Story')).toBeDisabled();

    await userEvent.click(
      within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' }),
    );
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(`/dashboard/interactive/${SESSION_ID}`),
    );
    expect(createSession).toHaveBeenCalledTimes(2);
    const [first, second] = createSession.mock.calls.map(([command]) => command);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first)); // same id, version and key
  });

  it('resends the exact original command even if the catalogue changed meanwhile', async () => {
    createSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    createSession.mockResolvedValueOnce(makeView(0));
    listScenarios.mockResolvedValueOnce(makeCatalogue(DELIVERY));
    render(<InteractiveIntroPage />);
    await userEvent.click(await screen.findByRole('button', { name: /^Start story: / }));
    const alert = await screen.findByRole('alert');

    // A newer version is published and the catalogue is refreshed under the pending command.
    listScenarios.mockResolvedValue(
      makeCatalogue(
        makeCatalogueEntry({ scenarioVersion: 2, title: 'The Last Delivery (revised)' }),
      ),
    );
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    const [first, second] = createSession.mock.calls.map(([command]) => command);
    expect(first).toMatchObject({ scenarioId: 'warsaw-last-delivery', scenarioVersion: 1 });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('mints a new command for the next deliberate start after a definitive rejection', async () => {
    createSession.mockRejectedValueOnce(new ApiError(422, 'nope', 'UNKNOWN_SCENARIO'));
    createSession.mockResolvedValueOnce(makeView(0));
    await renderReady();

    await userEvent.click(startButton('The Last Delivery'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t be started/i);
    expect(startButton('The Last Delivery')).toBeEnabled();
    await userEvent.click(startButton('The Last Delivery'));
    await waitFor(() => expect(pushMock).toHaveBeenCalled());

    const [first, second] = createSession.mock.calls.map(([command]) => command);
    expect(second!.idempotencyKey).not.toBe(first!.idempotencyKey);
  });

  it('explains the session limit, does not retry, and offers a fresh start', async () => {
    createSession.mockRejectedValueOnce(new ApiError(409, 'limit', 'SESSION_LIMIT_REACHED'));
    await renderReady();

    await userEvent.click(startButton('The Last Delivery'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/maximum number of stories/i);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(pushMock).not.toHaveBeenCalled();
    expect(startButton('The Last Delivery')).toBeEnabled();
  });

  it('explains a rate limit, never retries by itself, and resends the same command on request', async () => {
    createSession.mockRejectedValueOnce(new ApiError(429, 'HTTP 429', 'RATE_LIMITED'));
    createSession.mockResolvedValueOnce(makeView(0));
    await renderReady();

    await userEvent.click(startButton('The Last Delivery'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/too quickly/i);
    expect(createSession).toHaveBeenCalledTimes(1);

    await userEvent.click(
      within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' }),
    );
    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    expect(createSession.mock.calls[1]![0]).toEqual(createSession.mock.calls[0]![0]);
  });

  it('drops the held command when the page unmounts, so a new visit starts fresh', async () => {
    createSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const first = render(<InteractiveIntroPage />);
    await userEvent.click(await screen.findByRole('button', { name: /^Start story: / }));
    await screen.findByRole('alert');
    first.unmount();

    createSession.mockResolvedValueOnce(makeView(0));
    render(<InteractiveIntroPage />);
    const button = await screen.findByRole('button', { name: /^Start story: / });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    expect(createSession.mock.calls[1]![0].idempotencyKey).not.toBe(
      createSession.mock.calls[0]![0].idempotencyKey,
    );
  });

  it('shows a calm message for a server error', async () => {
    createSession.mockRejectedValueOnce(new ApiError(503, 'down'));
    await renderReady();

    await userEvent.click(startButton('The Last Delivery'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/second story|trouble/i);
  });

  it('does not navigate when the page unmounts before creation finishes', async () => {
    const gate = deferred<ReturnType<typeof makeView>>();
    createSession.mockReturnValueOnce(gate.promise);
    const { unmount } = render(<InteractiveIntroPage />);
    await userEvent.click(await screen.findByRole('button', { name: /^Start story: / }));

    unmount();
    gate.resolve(makeView(0));
    await Promise.resolve();

    expect(pushMock).not.toHaveBeenCalled();
  });

  it('does not navigate when the auth session changed during creation', async () => {
    const gate = deferred<ReturnType<typeof makeView>>();
    createSession.mockReturnValueOnce(gate.promise);
    render(<InteractiveIntroPage />);
    await userEvent.click(await screen.findByRole('button', { name: /^Start story: / }));

    advanceSessionEpoch();
    gate.resolve(makeView(0));
    await Promise.resolve();
    await Promise.resolve();

    expect(pushMock).not.toHaveBeenCalled();
  });
});
