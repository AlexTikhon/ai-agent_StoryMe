import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InteractivePresentationDto, InteractiveSessionViewDto } from '@book/types';
import { useParams, useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { advanceSessionEpoch } from '@/lib/auth/token-store';
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
    getPresentation: vi.fn(),
  },
}));

const getSession = vi.mocked(interactiveApi.getSession);
const submitChoice = vi.mocked(interactiveApi.submitChoice);
const getPresentation = vi.mocked(interactiveApi.getPresentation);

let auth: { status: string; user: { id: string } | null };

const COURTYARD = makeView(0, {
  scene: { id: 's-courtyard', title: 'Praga courtyard' },
  narration: 'Rain taps the cobbles.',
  choices: [{ id: 'c-ask-caretaker', label: 'Ask the caretaker' }],
});
const CARETAKER = makeView(1, {
  scene: { id: 's-caretaker', title: "The caretaker's broom" },
  narration: 'Ines puts down her broom.',
  choices: [{ id: 'c-climb', label: 'Climb to the fourth floor' }],
});

function dtoFor(view: InteractiveSessionViewDto, slug: string): InteractivePresentationDto {
  return {
    sessionId: view.sessionId,
    revision: view.revision,
    scenarioId: view.scenarioId,
    scenarioVersion: view.scenarioVersion,
    sceneId: view.scene.id,
    presentation: {
      packId: 'warsaw-noir',
      packVersion: 1,
      panels: [
        {
          id: `p-${slug}`,
          src: `/interactive/warsaw-noir/v1/${slug}.svg`,
          width: 1200,
          height: 800,
          alt: `Artwork of ${slug}`,
        },
      ],
    },
  };
}

const art = (slug: string) => screen.queryByAltText(`Artwork of ${slug}`);

beforeEach(() => {
  vi.mocked(useParams).mockReturnValue({ sessionId: SESSION_ID });
  vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as unknown as ReturnType<
    typeof useRouter
  >);
  auth = { status: 'authed', user: { id: 'user-1' } };
  vi.mocked(useAuth).mockImplementation(() => auth as unknown as ReturnType<typeof useAuth>);
  getSession.mockReset();
  submitChoice.mockReset();
  getPresentation.mockReset();
});

describe('reader illustrations', () => {
  it('fetches artwork only after the authoritative view and renders it beside the text', async () => {
    const gateView = deferred<InteractiveSessionViewDto>();
    getSession.mockReturnValueOnce(gateView.promise);
    getPresentation.mockResolvedValueOnce(dtoFor(COURTYARD, 's-courtyard'));
    render(<InteractiveReaderPage />);

    expect(getPresentation).not.toHaveBeenCalled(); // no view yet: nothing to illustrate
    await act(async () => gateView.resolve(COURTYARD));

    const image = await screen.findByAltText('Artwork of s-courtyard');
    expect(image).toHaveAttribute('src', '/interactive/warsaw-noir/v1/s-courtyard.svg');
    expect(image).toHaveAttribute('width', '1200');
    expect(image).toHaveAttribute('height', '800');
    expect(getPresentation).toHaveBeenCalledTimes(1);
    expect(getPresentation.mock.calls[0]![1]).toBe(0);
    // Text, heading and choices are ordinary HTML, not part of the picture.
    expect(screen.getByRole('heading', { name: 'Praga courtyard' })).toBeInTheDocument();
    expect(screen.getByText('Rain taps the cobbles.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask the caretaker' })).toBeEnabled();
  });

  it('reserves space while loading and keeps choices usable meanwhile', async () => {
    getSession.mockResolvedValueOnce(COURTYARD);
    getPresentation.mockReturnValueOnce(new Promise(() => {})); // never answers
    render(<InteractiveReaderPage />);

    const placeholder = await screen.findByTestId('illustration-placeholder');
    expect(placeholder.style.aspectRatio).toBe('3 / 2');
    expect(placeholder).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: 'Ask the caretaker' })).toBeEnabled();
  });

  it('never shows old-scene artwork under new-scene text, even if the old answer arrives late', async () => {
    getSession.mockResolvedValueOnce(COURTYARD);
    const gate0 = deferred<InteractivePresentationDto>();
    const gate1 = deferred<InteractivePresentationDto>();
    getPresentation.mockReturnValueOnce(gate0.promise).mockReturnValueOnce(gate1.promise);
    submitChoice.mockResolvedValueOnce(CARETAKER);
    render(<InteractiveReaderPage />);
    await screen.findByRole('heading', { name: 'Praga courtyard' });
    await waitFor(() => expect(getPresentation).toHaveBeenCalledTimes(1));

    // The player chooses while the first picture is still on its way.
    await userEvent.click(screen.getByRole('button', { name: 'Ask the caretaker' }));
    expect(
      await screen.findByRole('heading', { name: "The caretaker's broom" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(getPresentation).toHaveBeenCalledTimes(2));
    expect(getPresentation.mock.calls[1]![1]).toBe(1);

    await act(async () => gate0.resolve(dtoFor(COURTYARD, 's-courtyard'))); // late
    expect(art('s-courtyard')).toBeNull();
    expect(screen.getByTestId('illustration-placeholder')).toBeInTheDocument();
    expect(screen.getByText('Ines puts down her broom.')).toBeInTheDocument();

    await act(async () => gate1.resolve(dtoFor(CARETAKER, 's-caretaker')));
    expect(art('s-caretaker')).not.toBeNull();
    expect(art('s-courtyard')).toBeNull();
  });

  it('swaps the artwork in the same render pass as the text after a choice', async () => {
    getSession.mockResolvedValueOnce(COURTYARD);
    getPresentation
      .mockResolvedValueOnce(dtoFor(COURTYARD, 's-courtyard'))
      .mockReturnValueOnce(new Promise(() => {}));
    submitChoice.mockResolvedValueOnce(CARETAKER);
    render(<InteractiveReaderPage />);
    await screen.findByAltText('Artwork of s-courtyard');

    await userEvent.click(screen.getByRole('button', { name: 'Ask the caretaker' }));
    await screen.findByRole('heading', { name: "The caretaker's broom" });
    // New text is on screen; the previous scene's picture must already be gone.
    expect(art('s-courtyard')).toBeNull();
  });

  it('discards a late answer after logout and login as the same account', async () => {
    getSession.mockResolvedValue(COURTYARD);
    const gate0 = deferred<InteractivePresentationDto>();
    const gate1 = deferred<InteractivePresentationDto>();
    getPresentation.mockReturnValueOnce(gate0.promise).mockReturnValueOnce(gate1.promise);
    const { rerender } = render(<InteractiveReaderPage />);
    await screen.findByRole('heading', { name: 'Praga courtyard' });
    await waitFor(() => expect(getPresentation).toHaveBeenCalledTimes(1));

    // Logout then login (same user id): a new auth epoch and a fresh reader scope.
    advanceSessionEpoch();
    auth = { status: 'anon', user: null };
    rerender(<InteractiveReaderPage />);
    advanceSessionEpoch();
    auth = { status: 'authed', user: { id: 'user-1' } };
    rerender(<InteractiveReaderPage />);
    await screen.findByRole('heading', { name: 'Praga courtyard' });
    await waitFor(() => expect(getPresentation).toHaveBeenCalledTimes(2));

    await act(async () => gate0.resolve(dtoFor(COURTYARD, 'stale-answer')));
    expect(art('stale-answer')).toBeNull();
    await act(async () => gate1.resolve(dtoFor(COURTYARD, 's-courtyard')));
    expect(art('s-courtyard')).not.toBeNull();
    expect(art('stale-answer')).toBeNull();
  });

  it('keeps the text reader and every choice usable when the artwork service is down', async () => {
    getSession.mockResolvedValueOnce(COURTYARD);
    getPresentation.mockRejectedValue(new ApiError(503, 'down', 'SERVICE_UNAVAILABLE'));
    submitChoice.mockResolvedValueOnce(CARETAKER);
    render(<InteractiveReaderPage />);

    expect(await screen.findByText(/illustration isn.t available/i)).toBeInTheDocument();
    expect(screen.getByText('Rain taps the cobbles.')).toBeInTheDocument();
    const choice = screen.getByRole('button', { name: 'Ask the caretaker' });
    expect(choice).toBeEnabled();

    await userEvent.click(choice);
    expect(
      await screen.findByRole('heading', { name: "The caretaker's broom" }),
    ).toBeInTheDocument();
    expect(submitChoice).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Climb to the fourth floor' })).toBeEnabled();
  });

  it('offers a manual reload that recovers the picture, without sending anything to the story', async () => {
    getSession.mockResolvedValueOnce(COURTYARD);
    getPresentation
      .mockRejectedValueOnce(new ApiError(500, 'boom', 'INTERNAL'))
      .mockResolvedValueOnce(dtoFor(COURTYARD, 's-courtyard'));
    render(<InteractiveReaderPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Reload illustration' }));
    expect(await screen.findByAltText('Artwork of s-courtyard')).toBeInTheDocument();
    expect(getPresentation).toHaveBeenCalledTimes(2);
    expect(submitChoice).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it('degrades a broken image to text without disabling choices, with a bounded reload', async () => {
    getSession.mockResolvedValueOnce(COURTYARD);
    getPresentation.mockResolvedValueOnce(dtoFor(COURTYARD, 's-courtyard'));
    render(<InteractiveReaderPage />);

    const image = await screen.findByAltText('Artwork of s-courtyard');
    fireEvent.error(image);
    expect(art('s-courtyard')).toBeNull();
    expect(screen.getByText(/illustration isn.t available/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask the caretaker' })).toBeEnabled();
    expect(getPresentation).toHaveBeenCalledTimes(1);

    // Two manual reloads are allowed, then the button goes away.
    for (let i = 0; i < 2; i += 1) {
      await userEvent.click(screen.getByRole('button', { name: 'Reload illustration' }));
      fireEvent.error(await screen.findByAltText('Artwork of s-courtyard'));
    }
    expect(screen.queryByRole('button', { name: 'Reload illustration' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Ask the caretaker' })).toBeEnabled();
    expect(getPresentation).toHaveBeenCalledTimes(1); // image retries never re-ask the API
  });

  it('shows nothing extra when no artwork is configured', async () => {
    getSession.mockResolvedValueOnce(COURTYARD);
    getPresentation.mockResolvedValueOnce({ ...dtoFor(COURTYARD, 'x'), presentation: null });
    render(<InteractiveReaderPage />);

    await screen.findByRole('heading', { name: 'Praga courtyard' });
    await waitFor(() => expect(getPresentation).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('illustration-placeholder')).toBeNull());
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText(/illustration isn.t available/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Ask the caretaker' })).toBeEnabled();
  });

  it('does not touch the choice flow: the submitted command is unchanged by illustrations', async () => {
    getSession.mockResolvedValueOnce(COURTYARD);
    getPresentation.mockResolvedValue(dtoFor(COURTYARD, 's-courtyard'));
    submitChoice.mockResolvedValueOnce(CARETAKER);
    render(<InteractiveReaderPage />);
    await screen.findByAltText('Artwork of s-courtyard');

    await userEvent.click(screen.getByRole('button', { name: 'Ask the caretaker' }));
    await screen.findByRole('heading', { name: "The caretaker's broom" });
    expect(submitChoice).toHaveBeenCalledTimes(1);
    const [, command] = submitChoice.mock.calls[0]!;
    expect(Object.keys(command).sort()).toEqual(['choiceId', 'expectedRevision', 'idempotencyKey']);
    expect(command).toMatchObject({ choiceId: 'c-ask-caretaker', expectedRevision: 0 });
  });
});
