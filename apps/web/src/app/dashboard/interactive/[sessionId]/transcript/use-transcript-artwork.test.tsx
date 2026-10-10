import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { InteractiveTranscriptPresentationDto } from '@book/types';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { advanceSessionEpoch, getSessionEpoch } from '@/lib/auth/token-store';
import {
  SESSION_ID,
  deferred,
  makeArtworkPage,
  makeTranscriptPage,
} from '../../interactive-test-fixtures';
import { describeAcceptedPage, type AcceptedTranscriptPage } from './accepted-page';
import {
  MAX_ARTWORK_METADATA_RETRIES,
  MAX_ARTWORK_REQUESTS_IN_FLIGHT,
  TRANSCRIPT_ARTWORK_DEADLINE_MS,
  useTranscriptArtwork,
} from './use-transcript-artwork';

vi.mock('@/lib/api/interactive', () => ({
  interactiveApi: { getTranscriptPresentation: vi.fn() },
}));

const getArtwork = vi.mocked(interactiveApi.getTranscriptPresentation);

/** A story completed at revision 8: pages 0-2, 3-5, 6-8 (three steps each) and a lone 9th is not needed. */
const TEXT = [
  makeTranscriptPage(0, 2, 8),
  makeTranscriptPage(3, 5, 8),
  makeTranscriptPage(6, 8, 8),
];
const CURSORS = [null, 'cursor-3', 'cursor-6'];
const PAGES: AcceptedTranscriptPage[] = TEXT.map((page, i) =>
  describeAcceptedPage(page, { limit: 3, cursor: CURSORS[i]! }),
);
const art = (i: number, options?: Parameters<typeof makeArtworkPage>[1]) =>
  makeArtworkPage(TEXT[i]!, options);

const SCOPE = `${SESSION_ID}|user-1|e0`;

function mount(initial: { scopeKey: string | null; pages: readonly AcceptedTranscriptPage[] }) {
  return renderHook((props) => useTranscriptArtwork(props.scopeKey, props.pages), {
    initialProps: initial,
  });
}

const statusOf = (result: { current: ReturnType<typeof useTranscriptArtwork> }, revision: number) =>
  result.current.forRevision(revision)?.status;
const panelIds = (result: { current: ReturnType<typeof useTranscriptArtwork> }, revision: number) =>
  result.current.forRevision(revision)?.panels.map((p) => p.id);

const apiError = (status: number, code: string) => new ApiError(status, code, code);

beforeEach(() => {
  getArtwork.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTranscriptArtwork — requests', () => {
  it('requests one page of artwork with the exact parameters of its text page', async () => {
    getArtwork.mockResolvedValueOnce(art(0));
    const { result } = mount({ scopeKey: SCOPE, pages: [PAGES[0]!] });
    expect(statusOf(result, 0)).toBe('loading');
    await act(async () => {});

    expect(getArtwork).toHaveBeenCalledTimes(1); // one per page, never per chapter
    expect(getArtwork).toHaveBeenCalledWith(
      SESSION_ID,
      { limit: 3, cursor: null },
      expect.any(AbortSignal),
    );
    expect(statusOf(result, 0)).toBe('ready');
    expect(panelIds(result, 0)).toEqual(['p-scene-0']);
    expect(panelIds(result, 2)).toEqual(['p-scene-2']);
  });

  it('asks for nothing before a text page is accepted, and nothing for unloaded chapters', async () => {
    mount({ scopeKey: SCOPE, pages: [] });
    await act(async () => {});
    expect(getArtwork).not.toHaveBeenCalled();
  });

  it('requests artwork for a later page only once that page is accepted, with its cursor', async () => {
    getArtwork.mockResolvedValueOnce(art(0));
    const { result, rerender } = mount({ scopeKey: SCOPE, pages: [PAGES[0]!] });
    await act(async () => {});

    getArtwork.mockResolvedValueOnce(art(1));
    rerender({ scopeKey: SCOPE, pages: [PAGES[0]!, PAGES[1]!] });
    await act(async () => {});

    expect(getArtwork).toHaveBeenCalledTimes(2); // page one is not requested again
    expect(getArtwork.mock.calls[1]![1]).toEqual({ limit: 3, cursor: 'cursor-3' });
    expect(panelIds(result, 4)).toEqual(['p-scene-4']);
    expect(result.current.forRevision(6)).toBeNull(); // not loaded, not illustrated
  });

  it('keeps at most two artwork requests in flight and starts queued pages in order', async () => {
    const gates = TEXT.map(() => deferred<InteractiveTranscriptPresentationDto>());
    getArtwork.mockImplementation((_id, params) => {
      const index = CURSORS.indexOf(params?.cursor ?? null);
      return gates[index]!.promise;
    });
    const { result } = mount({ scopeKey: SCOPE, pages: PAGES });
    await act(async () => {});

    expect(MAX_ARTWORK_REQUESTS_IN_FLIGHT).toBe(2);
    expect(getArtwork).toHaveBeenCalledTimes(2);
    expect(getArtwork.mock.calls.map((c) => c[1]?.cursor ?? null)).toEqual([null, 'cursor-3']);
    expect(statusOf(result, 6)).toBe('loading'); // queued, placeholder only

    await act(async () => gates[1]!.resolve(art(1)));
    expect(getArtwork).toHaveBeenCalledTimes(3);
    expect(getArtwork.mock.calls[2]![1]).toEqual({ limit: 3, cursor: 'cursor-6' });
    await act(async () => {
      gates[0]!.resolve(art(0));
      gates[2]!.resolve(art(2));
    });
    expect([0, 3, 6].map((r) => statusOf(result, r))).toEqual(['ready', 'ready', 'ready']);
  });

  it('attaches out-of-order responses only to their own chapters', async () => {
    const gates = [
      deferred<InteractiveTranscriptPresentationDto>(),
      deferred<InteractiveTranscriptPresentationDto>(),
    ];
    getArtwork.mockImplementation((_id, params) => gates[params?.cursor ? 1 : 0]!.promise);
    const { result } = mount({ scopeKey: SCOPE, pages: [PAGES[0]!, PAGES[1]!] });
    await act(async () => {});

    await act(async () => gates[1]!.resolve(art(1)));
    expect(statusOf(result, 0)).toBe('loading');
    expect(panelIds(result, 3)).toEqual(['p-scene-3']);
    await act(async () => gates[0]!.resolve(art(0)));
    expect(panelIds(result, 0)).toEqual(['p-scene-0']);
    expect(panelIds(result, 3)).toEqual(['p-scene-3']);
  });

  it('treats a page without configured artwork as nothing to show', async () => {
    getArtwork.mockResolvedValueOnce(art(0, { pack: false }));
    const { result } = mount({ scopeKey: SCOPE, pages: [PAGES[0]!] });
    await act(async () => {});
    expect([0, 1, 2].map((r) => statusOf(result, r))).toEqual(['none', 'none', 'none']);
    expect(panelIds(result, 0)).toEqual([]);
  });

  it('does not re-request on re-render or when the same pages are passed again', async () => {
    getArtwork.mockResolvedValue(art(0));
    const { rerender } = mount({ scopeKey: SCOPE, pages: [PAGES[0]!] });
    await act(async () => {});
    rerender({ scopeKey: SCOPE, pages: [PAGES[0]!] });
    rerender({ scopeKey: SCOPE, pages: [PAGES[0]!] });
    await act(async () => {});
    expect(getArtwork).toHaveBeenCalledTimes(1);
  });
});

describe('useTranscriptArtwork — rejected and failed answers', () => {
  it.each<[string, (page: InteractiveTranscriptPresentationDto) => unknown]>([
    ['another session', (p) => ({ ...p, sessionId: 'other' })],
    ['another completed revision', (p) => ({ ...p, completedRevision: 5 })],
    ['another cursor', (p) => ({ ...p, nextCursor: 'cursor-99' })],
    ['other scene ids', (p) => ({ ...p, steps: p.steps.map((s) => ({ ...s, sceneId: 'x' })) })],
    [
      'an unsafe src',
      (p) => ({
        ...p,
        steps: p.steps.map((s) => ({
          ...s,
          presentation: {
            ...s.presentation!,
            panels: [{ ...s.presentation!.panels[0]!, src: 'https://evil.example/a.svg' }],
          },
        })),
      }),
    ],
    ['garbage', () => ({ steps: 7 })],
  ])('attaches nothing from a page answered with %s', async (_name, mutate) => {
    getArtwork.mockResolvedValueOnce(mutate(art(0)) as InteractiveTranscriptPresentationDto);
    const { result } = mount({ scopeKey: SCOPE, pages: [PAGES[0]!] });
    await act(async () => {});
    expect([0, 1, 2].map((r) => statusOf(result, r))).toEqual(['none', 'none', 'none']);
    expect([0, 1, 2].map((r) => result.current.forRevision(r)?.canRetry)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('shows one failure note per page and keeps other pages unaffected', async () => {
    getArtwork.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    getArtwork.mockResolvedValueOnce(art(1));
    const { result } = mount({ scopeKey: SCOPE, pages: [PAGES[0]!, PAGES[1]!] });
    await act(async () => {});

    expect([0, 1, 2].map((r) => statusOf(result, r))).toEqual(['error', 'error', 'error']);
    expect([0, 1, 2].map((r) => result.current.forRevision(r)?.showsNote)).toEqual([
      true,
      false,
      false,
    ]);
    expect(statusOf(result, 3)).toBe('ready');
  });

  it('maps a rate limit to a retryable error and a missing session to nothing', async () => {
    getArtwork.mockRejectedValueOnce(apiError(429, 'RATE_LIMITED'));
    getArtwork.mockRejectedValueOnce(apiError(404, 'SESSION_NOT_FOUND'));
    const { result } = mount({ scopeKey: SCOPE, pages: [PAGES[0]!, PAGES[1]!] });
    await act(async () => {});
    expect(statusOf(result, 0)).toBe('error');
    expect(statusOf(result, 3)).toBe('none');
  });

  it('treats a synchronous throw from the client as an outage', async () => {
    getArtwork.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const { result } = mount({ scopeKey: SCOPE, pages: [PAGES[0]!] });
    await act(async () => {});
    expect(statusOf(result, 0)).toBe('error');
  });
});

describe('useTranscriptArtwork — manual retry', () => {
  it('retries a failed page with the exact same query, at most twice', async () => {
    getArtwork.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = mount({ scopeKey: SCOPE, pages: [PAGES[0]!, PAGES[1]!] });
    await act(async () => {});
    const callsBefore = getArtwork.mock.calls.length;
    expect(MAX_ARTWORK_METADATA_RETRIES).toBe(2);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      expect(result.current.forRevision(3)?.canRetry).toBe(true);
      await act(async () => result.current.forRevision(3)!.retry());
    }
    expect(getArtwork.mock.calls.length).toBe(callsBefore + 2);
    for (const call of getArtwork.mock.calls.slice(callsBefore)) {
      expect(call[0]).toBe(SESSION_ID);
      expect(call[1]).toEqual({ limit: 3, cursor: 'cursor-3' });
    }
    // Budget spent: no further button, and a stray call is a no-op.
    expect(result.current.forRevision(3)?.canRetry).toBe(false);
    await act(async () => result.current.forRevision(3)!.retry());
    expect(getArtwork.mock.calls.length).toBe(callsBefore + 2);
    // The other page keeps its own budget.
    expect(result.current.forRevision(0)?.canRetry).toBe(true);
  });

  it('sends one request for duplicate retry clicks', async () => {
    getArtwork.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = mount({ scopeKey: SCOPE, pages: [PAGES[0]!] });
    await act(async () => {});

    const gate = deferred<InteractiveTranscriptPresentationDto>();
    getArtwork.mockReturnValueOnce(gate.promise);
    const retry = result.current.forRevision(0)!.retry;
    await act(async () => {
      retry();
      retry();
      retry();
    });
    expect(getArtwork).toHaveBeenCalledTimes(2);
    expect(statusOf(result, 0)).toBe('loading');
    await act(async () => gate.resolve(art(0)));
    expect(statusOf(result, 0)).toBe('ready');
  });

  it('recovers when the retry succeeds, without touching other pages', async () => {
    getArtwork.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    getArtwork.mockResolvedValueOnce(art(1));
    const { result } = mount({ scopeKey: SCOPE, pages: [PAGES[0]!, PAGES[1]!] });
    await act(async () => {});

    getArtwork.mockResolvedValueOnce(art(0));
    await act(async () => result.current.forRevision(0)!.retry());
    expect(statusOf(result, 0)).toBe('ready');
    expect(getArtwork).toHaveBeenCalledTimes(3);
  });

  it('ignores the answer of a request that a retry replaced', async () => {
    vi.useFakeTimers();
    const first = deferred<InteractiveTranscriptPresentationDto>();
    getArtwork.mockReturnValueOnce(first.promise);
    const { result } = mount({ scopeKey: SCOPE, pages: [PAGES[0]!] });
    await act(async () => {});

    await act(async () => vi.advanceTimersByTime(TRANSCRIPT_ARTWORK_DEADLINE_MS));
    expect(statusOf(result, 0)).toBe('error');

    const second = deferred<InteractiveTranscriptPresentationDto>();
    getArtwork.mockReturnValueOnce(second.promise);
    await act(async () => result.current.forRevision(0)!.retry());
    // The abandoned first request answers late with *different* artwork: it must not land.
    await act(async () => first.resolve(art(0, { pack: false })));
    expect(statusOf(result, 0)).toBe('loading');
    await act(async () => second.resolve(art(0)));
    expect(panelIds(result, 0)).toEqual(['p-scene-0']);
  });
});

describe('useTranscriptArtwork — deadline, cancellation and scope', () => {
  it('gives up after the deadline, aborts the request and ignores its late answer', async () => {
    vi.useFakeTimers();
    const gate = deferred<InteractiveTranscriptPresentationDto>();
    let signal: AbortSignal | undefined;
    getArtwork.mockImplementationOnce((_id, _params, s) => {
      signal = s;
      return gate.promise;
    });
    const { result } = mount({ scopeKey: SCOPE, pages: [PAGES[0]!] });
    await act(async () => {});
    expect(statusOf(result, 0)).toBe('loading');

    await act(async () => vi.advanceTimersByTime(TRANSCRIPT_ARTWORK_DEADLINE_MS - 1));
    expect(statusOf(result, 0)).toBe('loading');
    await act(async () => vi.advanceTimersByTime(1));
    expect(statusOf(result, 0)).toBe('error');
    expect(signal?.aborted).toBe(true);

    await act(async () => gate.resolve(art(0)));
    expect(statusOf(result, 0)).toBe('error'); // not resurrected by the late answer
  });

  it('a timed-out request frees its slot for the queue', async () => {
    vi.useFakeTimers();
    getArtwork.mockImplementation(() => new Promise(() => {}));
    mount({ scopeKey: SCOPE, pages: PAGES });
    await act(async () => {});
    expect(getArtwork).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTime(TRANSCRIPT_ARTWORK_DEADLINE_MS));
    expect(getArtwork).toHaveBeenCalledTimes(3);
    expect(getArtwork.mock.calls[2]![1]).toEqual({ limit: 3, cursor: 'cursor-6' });
  });

  it('aborts in-flight requests on unmount and ignores their late answers', async () => {
    const gate = deferred<InteractiveTranscriptPresentationDto>();
    let signal: AbortSignal | undefined;
    getArtwork.mockImplementationOnce((_id, _params, s) => {
      signal = s;
      return gate.promise;
    });
    const { unmount } = mount({ scopeKey: SCOPE, pages: [PAGES[0]!] });
    await act(async () => {});
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => gate.resolve(art(0))); // must not throw or update an unmounted tree
  });

  it('clears artwork in the same render the scope changes, never showing the old scope', async () => {
    getArtwork.mockResolvedValueOnce(art(0));
    const seen: (string | undefined)[] = [];
    const { rerender } = renderHook(
      (p: { scopeKey: string | null; pages: readonly AcceptedTranscriptPage[] }) => {
        const value = useTranscriptArtwork(p.scopeKey, p.pages);
        seen.push(value.forRevision(0)?.status);
        return value;
      },
      { initialProps: { scopeKey: SCOPE as string | null, pages: [PAGES[0]!] } },
    );
    await act(async () => {});
    expect(seen.at(-1)).toBe('ready');

    getArtwork.mockReturnValueOnce(new Promise(() => {}));
    seen.length = 0;
    rerender({ scopeKey: `${SESSION_ID}|user-2|e0`, pages: [PAGES[0]!] });
    expect(seen[0]).toBe('loading'); // the very first render of the new scope
    expect(seen).not.toContain('ready');

    seen.length = 0;
    rerender({ scopeKey: null, pages: [] });
    expect(seen[0]).toBeUndefined();
  });

  it('ignores a late answer from the previous scope after the scope changed', async () => {
    const stale = deferred<InteractiveTranscriptPresentationDto>();
    getArtwork.mockReturnValueOnce(stale.promise);
    const { result, rerender } = mount({ scopeKey: SCOPE, pages: [PAGES[0]!] });
    await act(async () => {});

    const fresh = deferred<InteractiveTranscriptPresentationDto>();
    getArtwork.mockReturnValueOnce(fresh.promise);
    rerender({ scopeKey: `${SESSION_ID}|user-1|e1`, pages: [PAGES[0]!] });
    await act(async () => {});
    expect(getArtwork).toHaveBeenCalledTimes(2);

    await act(async () => stale.resolve(art(0, { pack: false }))); // would turn this to "none"
    expect(statusOf(result, 0)).toBe('loading');
    await act(async () => fresh.resolve(art(0)));
    expect(panelIds(result, 0)).toEqual(['p-scene-0']);
  });

  it('ignores a late answer after logout and login as the same account', async () => {
    const gate = deferred<InteractiveTranscriptPresentationDto>();
    getArtwork.mockReturnValueOnce(gate.promise);
    const epoch = getSessionEpoch();
    const { result } = mount({ scopeKey: `${SESSION_ID}|user-1|e${epoch}`, pages: [PAGES[0]!] });
    await act(async () => {});

    advanceSessionEpoch(); // logout/login happened; the old key is still being rendered
    await act(async () => gate.resolve(art(0)));
    expect(statusOf(result, 0)).toBe('loading');
  });

  it('drops pages that are no longer accepted and aborts their requests', async () => {
    let signal: AbortSignal | undefined;
    getArtwork.mockImplementationOnce((_id, _params, s) => {
      signal = s;
      return new Promise(() => {});
    });
    const { result, rerender } = mount({ scopeKey: SCOPE, pages: [PAGES[0]!] });
    await act(async () => {});
    rerender({ scopeKey: SCOPE, pages: [] });
    expect(signal?.aborted).toBe(true);
    expect(result.current.forRevision(0)).toBeNull();
  });
});
