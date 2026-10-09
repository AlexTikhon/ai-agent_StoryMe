import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { InteractivePresentationDto, InteractiveSessionViewDto } from '@book/types';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { advanceSessionEpoch } from '@/lib/auth/token-store';
import { SESSION_ID, deferred, makeView } from '../interactive-test-fixtures';
import {
  MAX_ILLUSTRATION_RETRIES,
  PRESENTATION_DEADLINE_MS,
  useScenePresentation,
} from './use-scene-presentation';

vi.mock('@/lib/api/interactive', () => ({
  interactiveApi: { getPresentation: vi.fn() },
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: vi.fn() }));

const getPresentation = vi.mocked(interactiveApi.getPresentation);

let auth: { status: string; user: { id: string } | null };

const SCENES: Record<number, { id: string; title: string }> = {
  0: { id: 's-courtyard', title: 'Praga courtyard' },
  1: { id: 's-caretaker', title: "The caretaker's broom" },
  2: { id: 's-door', title: 'Flat 4' },
};

function viewAt(revision: number, overrides: Partial<InteractiveSessionViewDto> = {}) {
  return makeView(revision, { scene: SCENES[revision] ?? SCENES[0]!, ...overrides });
}

function dtoFor(view: InteractiveSessionViewDto, name = view.scene.id): InteractivePresentationDto {
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
          id: `p-${name}`,
          src: `/interactive/warsaw-noir/v1/${name}.svg`,
          width: 1200,
          height: 800,
          alt: `Artwork for ${name}`,
        },
      ],
    },
  };
}

function apiError(status: number, code: string) {
  return new ApiError(status, code, code);
}

function mount(initial: InteractiveSessionViewDto | null) {
  return renderHook(({ view }) => useScenePresentation(view), { initialProps: { view: initial } });
}

beforeEach(() => {
  auth = { status: 'authed', user: { id: 'user-1' } };
  vi.mocked(useAuth).mockImplementation(() => auth as unknown as ReturnType<typeof useAuth>);
  getPresentation.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useScenePresentation', () => {
  it('stays idle and sends nothing without an authoritative view', () => {
    const hook = mount(null);
    expect(hook.result.current.status).toBe('idle');
    expect(getPresentation).not.toHaveBeenCalled();
  });

  it('stays idle while signed out', () => {
    auth = { status: 'anon', user: null };
    const hook = mount(viewAt(0));
    expect(hook.result.current.status).toBe('idle');
    expect(getPresentation).not.toHaveBeenCalled();
  });

  it('requests the displayed revision once, shows loading, then the panels', async () => {
    const view = viewAt(0);
    const gate = deferred<InteractivePresentationDto>();
    getPresentation.mockReturnValueOnce(gate.promise);
    const hook = mount(view);

    expect(hook.result.current.status).toBe('loading');
    expect(hook.result.current.panels).toEqual([]);
    await waitFor(() => expect(getPresentation).toHaveBeenCalledTimes(1));
    expect(getPresentation.mock.calls[0]![0]).toBe(SESSION_ID);
    expect(getPresentation.mock.calls[0]![1]).toBe(0);

    await act(async () => gate.resolve(dtoFor(view)));
    expect(hook.result.current.status).toBe('ready');
    expect(hook.result.current.panels[0]!.id).toBe('p-s-courtyard');
    expect(getPresentation).toHaveBeenCalledTimes(1); // no polling, no refetch
  });

  it('never exposes old-scene artwork for the new scene — not even for one render', async () => {
    const first = viewAt(0);
    const second = viewAt(1);
    const gate0 = deferred<InteractivePresentationDto>();
    const gate1 = deferred<InteractivePresentationDto>();
    getPresentation.mockReturnValueOnce(gate0.promise).mockReturnValueOnce(gate1.promise);
    const hook = mount(first);
    await act(async () => gate0.resolve(dtoFor(first)));
    expect(hook.result.current.status).toBe('ready');

    const seen: string[] = [];
    hook.rerender({ view: second });
    seen.push(hook.result.current.status, ...hook.result.current.panels.map((p) => p.id));
    // Synchronously after the revision changed: loading, with no panels at all.
    expect(seen).toEqual(['loading']);

    await act(async () => gate1.resolve(dtoFor(second)));
    expect(hook.result.current.status).toBe('ready');
    expect(hook.result.current.panels[0]!.id).toBe('p-s-caretaker');
  });

  it('discards a late success for a previous scene', async () => {
    const first = viewAt(0);
    const second = viewAt(1);
    const gate0 = deferred<InteractivePresentationDto>();
    const gate1 = deferred<InteractivePresentationDto>();
    getPresentation.mockReturnValueOnce(gate0.promise).mockReturnValueOnce(gate1.promise);
    const hook = mount(first);
    await waitFor(() => expect(getPresentation).toHaveBeenCalledTimes(1));
    hook.rerender({ view: second });
    await waitFor(() => expect(getPresentation).toHaveBeenCalledTimes(2));

    await act(async () => gate0.resolve(dtoFor(first))); // arrives after the scene moved on
    expect(hook.result.current.status).toBe('loading');
    expect(hook.result.current.panels).toEqual([]);

    await act(async () => gate1.resolve(dtoFor(second)));
    expect(hook.result.current.panels.map((p) => p.id)).toEqual(['p-s-caretaker']);
  });

  it('discards a late failure for a previous scene instead of failing the new one', async () => {
    const first = viewAt(0);
    const second = viewAt(1);
    const gate0 = deferred<InteractivePresentationDto>();
    const gate1 = deferred<InteractivePresentationDto>();
    getPresentation.mockReturnValueOnce(gate0.promise).mockReturnValueOnce(gate1.promise);
    const hook = mount(first);
    await waitFor(() => expect(getPresentation).toHaveBeenCalledTimes(1));
    hook.rerender({ view: second });
    await waitFor(() => expect(getPresentation).toHaveBeenCalledTimes(2));

    await act(async () => gate0.reject(apiError(500, 'INTERNAL')));
    expect(hook.result.current.status).toBe('loading');
    expect(hook.result.current.canRetry).toBe(false);

    await act(async () => gate1.resolve(dtoFor(second)));
    expect(hook.result.current.status).toBe('ready');
  });

  it('discards a result after the auth epoch advances, even for the same account', async () => {
    const view = viewAt(0);
    const gate0 = deferred<InteractivePresentationDto>();
    const gate1 = deferred<InteractivePresentationDto>();
    getPresentation.mockReturnValueOnce(gate0.promise).mockReturnValueOnce(gate1.promise);
    const hook = mount(view);
    await waitFor(() => expect(getPresentation).toHaveBeenCalledTimes(1));

    advanceSessionEpoch(); // logout + login as the same user
    await act(async () => gate0.resolve(dtoFor(view)));
    expect(hook.result.current.status).toBe('loading');

    hook.rerender({ view: { ...view } }); // the reader re-renders under the new epoch
    await waitFor(() => expect(getPresentation).toHaveBeenCalledTimes(2));
    expect(hook.result.current.status).toBe('loading');
    await act(async () => gate1.resolve(dtoFor(view)));
    expect(hook.result.current.status).toBe('ready');
  });

  it('discards a result that arrives after logout', async () => {
    const view = viewAt(0);
    const gate = deferred<InteractivePresentationDto>();
    getPresentation.mockReturnValueOnce(gate.promise);
    const hook = mount(view);
    await waitFor(() => expect(getPresentation).toHaveBeenCalledTimes(1));

    auth = { status: 'anon', user: null };
    hook.rerender({ view: null });
    await act(async () => gate.resolve(dtoFor(view)));
    expect(hook.result.current.status).toBe('idle');
    expect(hook.result.current.panels).toEqual([]);
  });

  it('aborts the in-flight request and ignores its result after unmount', async () => {
    const view = viewAt(0);
    const gate = deferred<InteractivePresentationDto>();
    getPresentation.mockReturnValueOnce(gate.promise);
    const hook = mount(view);
    await waitFor(() => expect(getPresentation).toHaveBeenCalledTimes(1));
    const signal = getPresentation.mock.calls[0]![2]!;
    expect(signal.aborted).toBe(false);

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    hook.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => gate.resolve(dtoFor(view)));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('treats a revision conflict as "no artwork", offers no retry and does not refetch', async () => {
    getPresentation.mockRejectedValueOnce(apiError(409, 'REVISION_CONFLICT'));
    const hook = mount(viewAt(0));
    await waitFor(() => expect(hook.result.current.status).toBe('none'));
    expect(hook.result.current.canRetry).toBe(false);
    expect(getPresentation).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'a missing pack (presentation: null)',
      (view: InteractiveSessionViewDto) => ({ ...dtoFor(view), presentation: null }),
    ],
    [
      'an answer for another scene',
      (view: InteractiveSessionViewDto) => ({ ...dtoFor(view), sceneId: 's-cellar' }),
    ],
    [
      'an answer for another revision',
      (view: InteractiveSessionViewDto) => ({ ...dtoFor(view), revision: view.revision + 1 }),
    ],
    [
      'an answer for another session',
      (view: InteractiveSessionViewDto) => ({ ...dtoFor(view), sessionId: 'someone-elses' }),
    ],
    [
      'an answer for another scenario version',
      (view: InteractiveSessionViewDto) => ({ ...dtoFor(view), scenarioVersion: 2 }),
    ],
    [
      'an empty panel list',
      (view: InteractiveSessionViewDto) => ({
        ...dtoFor(view),
        presentation: { packId: 'warsaw-noir', packVersion: 1, panels: [] },
      }),
    ],
  ])('falls back to text-only for %s', async (_name, build) => {
    const view = viewAt(0);
    getPresentation.mockResolvedValueOnce(build(view));
    const hook = mount(view);
    await waitFor(() => expect(hook.result.current.status).toBe('none'));
    expect(hook.result.current.panels).toEqual([]);
  });

  it.each([
    'https://evil.example/interactive/warsaw-noir/v1/s-courtyard.svg',
    '//evil.example/interactive/warsaw-noir/v1/s-courtyard.svg',
    'javascript:alert(1)',
    '/interactive/warsaw-noir/v1/../../x.svg',
    '/interactive/warsaw-noir/v1/s-courtyard.svg?x=1',
    '/interactive/warsaw-noir/v1/s-courtyard.png',
    '/uploads/s-courtyard.svg',
  ])('never renders an unsafe asset path: %s', async (src) => {
    const view = viewAt(0);
    const dto = dtoFor(view);
    dto.presentation!.panels[0]!.src = src;
    getPresentation.mockResolvedValueOnce(dto);
    const hook = mount(view);
    await waitFor(() => expect(hook.result.current.status).toBe('none'));
    expect(hook.result.current.panels).toEqual([]);
  });

  it('reports an outage as an error with a bounded, manual-only retry', async () => {
    const view = viewAt(0);
    getPresentation.mockRejectedValue(apiError(503, 'SERVICE_UNAVAILABLE'));
    const hook = mount(view);
    await waitFor(() => expect(hook.result.current.status).toBe('error'));
    expect(hook.result.current.canRetry).toBe(true);
    expect(getPresentation).toHaveBeenCalledTimes(1); // nothing retried on its own

    for (let attempt = 1; attempt <= MAX_ILLUSTRATION_RETRIES; attempt += 1) {
      act(() => hook.result.current.retry());
      await waitFor(() => expect(getPresentation).toHaveBeenCalledTimes(1 + attempt));
      await waitFor(() => expect(hook.result.current.status).toBe('error'));
    }
    expect(hook.result.current.canRetry).toBe(false);
    act(() => hook.result.current.retry()); // beyond the bound: ignored
    expect(getPresentation).toHaveBeenCalledTimes(1 + MAX_ILLUSTRATION_RETRIES);
  });

  it('a manual retry can recover, and resets for the next scene', async () => {
    const first = viewAt(0);
    const second = viewAt(1);
    getPresentation
      .mockRejectedValueOnce(apiError(500, 'INTERNAL'))
      .mockResolvedValueOnce(dtoFor(first))
      .mockRejectedValueOnce(apiError(500, 'INTERNAL'));
    const hook = mount(first);
    await waitFor(() => expect(hook.result.current.status).toBe('error'));
    act(() => hook.result.current.retry());
    await waitFor(() => expect(hook.result.current.status).toBe('ready'));

    hook.rerender({ view: second });
    await waitFor(() => expect(hook.result.current.status).toBe('error'));
    expect(hook.result.current.canRetry).toBe(true); // a fresh bound for the new scene
  });

  it('turns a request that exceeds its deadline into an error without retrying', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    getPresentation.mockImplementation(
      (_id, _revision, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const hook = mount(viewAt(0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRESENTATION_DEADLINE_MS + 1);
    });
    expect(hook.result.current.status).toBe('error');
    expect(getPresentation).toHaveBeenCalledTimes(1);
  });

  it('never calls a story-state endpoint', async () => {
    // The mocked api exposes only getPresentation: any other call would throw.
    const view = viewAt(0);
    getPresentation.mockResolvedValueOnce(dtoFor(view));
    const hook = mount(view);
    await waitFor(() => expect(hook.result.current.status).toBe('ready'));
    expect(Object.keys(interactiveApi)).toEqual(['getPresentation']);
  });
});
