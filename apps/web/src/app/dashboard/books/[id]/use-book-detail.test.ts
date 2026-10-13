import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { BookStatus } from '@book/types';
import type { BookDto, GenerationDiagnosticsDto, GenerationProgressDto } from '@book/types';
import { booksApi } from '@/lib/api/books';
import { shouldAcceptBook, useBookDetail } from './use-book-detail';

vi.mock('@/lib/api/books', () => ({
  booksApi: {
    get: vi.fn(),
    getGenerationProgress: vi.fn(),
    getGenerationDiagnostics: vi.fn(),
  },
}));

function makeBook(overrides: Partial<BookDto> = {}): BookDto {
  return {
    id: 'book-1',
    status: BookStatus.Complete,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as BookDto;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const RUNNING: GenerationProgressDto = { status: 'running', step: null };

describe('shouldAcceptBook', () => {
  it('rejects a response for another book', () => {
    expect(shouldAcceptBook(makeBook({ id: 'a' }), makeBook({ id: 'b' }))).toBe(false);
  });

  it('rejects an older response and accepts an equal or newer one', () => {
    const current = makeBook({ updatedAt: '2026-01-02T00:00:00.000Z' });
    expect(shouldAcceptBook(current, makeBook({ updatedAt: '2026-01-01T00:00:00.000Z' }))).toBe(
      false,
    );
    expect(shouldAcceptBook(current, makeBook({ updatedAt: '2026-01-02T00:00:00.000Z' }))).toBe(
      true,
    );
    expect(shouldAcceptBook(current, makeBook({ updatedAt: '2026-01-03T00:00:00.000Z' }))).toBe(
      true,
    );
  });

  it('only replaces a cancelled book with a strictly newer record', () => {
    const cancelled = makeBook({ status: BookStatus.Cancelled });
    expect(shouldAcceptBook(cancelled, makeBook({ status: BookStatus.Complete }))).toBe(false);
    expect(
      shouldAcceptBook(
        cancelled,
        makeBook({ status: BookStatus.CharBuild, updatedAt: '2026-01-02T00:00:00.000Z' }),
      ),
    ).toBe(true);
  });
});

describe('useBookDetail request ownership', () => {
  beforeEach(() => {
    vi.mocked(booksApi.get).mockReset();
    vi.mocked(booksApi.getGenerationProgress).mockReset();
    vi.mocked(booksApi.getGenerationDiagnostics).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not start a second progress poll when an online event fires mid-request', async () => {
    const pending = deferred<GenerationProgressDto>();
    vi.mocked(booksApi.get).mockResolvedValue(makeBook({ status: BookStatus.CharBuild }));
    vi.mocked(booksApi.getGenerationProgress).mockReturnValue(pending.promise);

    const { unmount } = renderHook(() => useBookDetail('book-1', false));
    await waitFor(() => expect(booksApi.getGenerationProgress).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(booksApi.getGenerationProgress).toHaveBeenCalledTimes(1);

    // Settling the pending request must not leave an orphaned chain behind.
    await act(async () => {
      pending.resolve(RUNNING);
    });
    unmount();
  });

  it('aborts the in-flight poll request on unmount', async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(booksApi.get).mockResolvedValue(makeBook({ status: BookStatus.CharBuild }));
    vi.mocked(booksApi.getGenerationProgress).mockImplementation((_id, s) => {
      signal = s;
      return new Promise<GenerationProgressDto>(() => {});
    });

    const { unmount } = renderHook(() => useBookDetail('book-1', false));
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('ignores a manual refresh response that lands after the route changed', async () => {
    const staleRefresh = deferred<BookDto>();
    vi.mocked(booksApi.get).mockImplementation((id, signal) => {
      if (id === 'book-1' && !signal?.aborted && vi.mocked(booksApi.get).mock.calls.length > 1) {
        return staleRefresh.promise;
      }
      return Promise.resolve(makeBook({ id, title: `Book ${id}` } as Partial<BookDto>));
    });

    const { result, rerender } = renderHook(({ id }) => useBookDetail(id, false), {
      initialProps: { id: 'book-1' },
    });
    await waitFor(() => expect(result.current.book?.id).toBe('book-1'));

    act(() => {
      void result.current.handleRefresh();
    });
    expect(result.current.refreshing).toBe(true);

    rerender({ id: 'book-2' });
    await waitFor(() => expect(result.current.book?.id).toBe('book-2'));
    expect(result.current.refreshing).toBe(false);

    await act(async () => {
      staleRefresh.resolve(makeBook({ id: 'book-1', updatedAt: '2030-01-01T00:00:00.000Z' }));
    });

    expect(result.current.book?.id).toBe('book-2');
    expect(result.current.refreshing).toBe(false);
    expect(result.current.refreshError).toBeNull();
  });

  it('drops a delayed refresh that is older than a mutation result', async () => {
    const delayedRefresh = deferred<BookDto>();
    vi.mocked(booksApi.get).mockResolvedValueOnce(
      makeBook({ status: BookStatus.Failed, updatedAt: '2026-01-01T00:00:00.000Z' }),
    );

    const { result } = renderHook(() => useBookDetail('book-1', false));
    await waitFor(() => expect(result.current.book).not.toBeNull());

    vi.mocked(booksApi.get).mockReturnValueOnce(delayedRefresh.promise);
    act(() => {
      void result.current.handleRefresh();
    });

    // Regeneration lands via the page's mutation path while the refresh is pending.
    vi.mocked(booksApi.getGenerationProgress).mockResolvedValue(RUNNING);
    act(() => {
      result.current.setBook(
        makeBook({ status: BookStatus.CharBuild, updatedAt: '2026-01-02T00:00:00.000Z' }),
      );
    });

    await act(async () => {
      delayedRefresh.resolve(
        makeBook({ status: BookStatus.Failed, updatedAt: '2026-01-01T00:00:00.000Z' }),
      );
    });

    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(result.current.book?.status).toBe(BookStatus.CharBuild);
  });

  it('does not let a delayed refresh undo a cancellation', async () => {
    const delayedRefresh = deferred<BookDto>();
    vi.mocked(booksApi.get).mockResolvedValueOnce(
      makeBook({ status: BookStatus.Complete, updatedAt: '2026-01-01T00:00:00.000Z' }),
    );

    const { result } = renderHook(() => useBookDetail('book-1', false));
    await waitFor(() => expect(result.current.book).not.toBeNull());

    vi.mocked(booksApi.get).mockReturnValueOnce(delayedRefresh.promise);
    act(() => {
      void result.current.handleRefresh();
    });
    act(() => {
      result.current.setBook(
        makeBook({ status: BookStatus.Cancelled, updatedAt: '2026-01-02T00:00:00.000Z' }),
      );
    });

    await act(async () => {
      delayedRefresh.resolve(
        makeBook({ status: BookStatus.CharBuild, updatedAt: '2026-01-02T00:00:00.000Z' }),
      );
    });

    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(result.current.book?.status).toBe(BookStatus.Cancelled);
  });

  it('exposes a manual refresh failure instead of swallowing it', async () => {
    vi.mocked(booksApi.get).mockResolvedValueOnce(makeBook());

    const { result } = renderHook(() => useBookDetail('book-1', false));
    await waitFor(() => expect(result.current.book).not.toBeNull());

    vi.mocked(booksApi.get).mockRejectedValueOnce(new Error('Service unavailable'));
    await act(async () => {
      await result.current.handleRefresh();
    });

    expect(result.current.refreshError).toBe('Service unavailable');
    expect(result.current.refreshing).toBe(false);
    expect(result.current.book?.id).toBe('book-1');
  });

  it('ignores a second refresh click while one is already in flight', async () => {
    const pending = deferred<BookDto>();
    vi.mocked(booksApi.get).mockResolvedValueOnce(makeBook());

    const { result } = renderHook(() => useBookDetail('book-1', false));
    await waitFor(() => expect(result.current.book).not.toBeNull());

    vi.mocked(booksApi.get).mockReturnValueOnce(pending.promise);
    act(() => {
      void result.current.handleRefresh();
      void result.current.handleRefresh();
    });
    expect(booksApi.get).toHaveBeenCalledTimes(2); // initial load + a single refresh

    await act(async () => {
      pending.resolve(makeBook());
    });
    await waitFor(() => expect(result.current.refreshing).toBe(false));
  });
});

// Terminal polling. Every response is deferred and `setTimeout` is controlled, so
// which request happens when never depends on machine speed. Polling reads are
// the generation-progress and book reads; a diagnostics read is a legitimate,
// separate effect of the status change and is counted on its own.
describe('useBookDetail terminal polling', () => {
  const POLL_INTERVAL_MS = 2500;
  const T0 = '2026-01-01T00:00:00.000Z';
  const T1 = '2026-01-01T00:00:05.000Z';
  const COMPLETE_PROGRESS: GenerationProgressDto = { status: 'complete', step: null };

  let terminalProgress: Deferred<GenerationProgressDto>;
  let finalBook: Deferred<BookDto>;
  let diagnosticsReads: Deferred<GenerationDiagnosticsDto>[];

  const progressReads = () => vi.mocked(booksApi.getGenerationProgress).mock.calls.length;
  const bookReads = () => vi.mocked(booksApi.get).mock.calls.length;

  /** Runs due zero-delay timers and the microtasks, effects and renders they cause. */
  async function settle() {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }
  }

  async function fireRecoveryEventsAndIntervals(intervals: number) {
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * intervals);
    });
  }

  /** Mounts on a generating book and parks the hook on its in-flight final book read. */
  async function mountUntilFinalBookRead() {
    const hook = renderHook(() => useBookDetail('book-1', true));
    await settle();
    expect(progressReads()).toBe(1);
    expect(bookReads()).toBe(1);

    await act(async () => {
      terminalProgress.resolve(COMPLETE_PROGRESS);
      await vi.advanceTimersByTimeAsync(0);
    });
    // A terminal projection triggers exactly one full-book read.
    expect(progressReads()).toBe(1);
    expect(bookReads()).toBe(2);
    return hook;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.mocked(booksApi.get).mockReset();
    vi.mocked(booksApi.getGenerationProgress).mockReset();
    vi.mocked(booksApi.getGenerationDiagnostics).mockReset();

    terminalProgress = deferred<GenerationProgressDto>();
    finalBook = deferred<BookDto>();
    diagnosticsReads = [];

    // Reads after the expected ones answer with data that would visibly keep the
    // loop going, so an unwanted extra read is counted instead of hanging.
    vi.mocked(booksApi.get)
      .mockResolvedValueOnce(makeBook({ status: BookStatus.CharBuild, updatedAt: T0 }))
      .mockReturnValueOnce(finalBook.promise)
      .mockResolvedValue(makeBook({ status: BookStatus.CharBuild, updatedAt: T0 }));
    vi.mocked(booksApi.getGenerationProgress)
      .mockReturnValueOnce(terminalProgress.promise)
      .mockResolvedValue(RUNNING);
    vi.mocked(booksApi.getGenerationDiagnostics).mockImplementation(() => {
      const read = deferred<GenerationDiagnosticsDto>();
      diagnosticsReads.push(read);
      return read.promise;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('makes no further progress or book read after the terminal book is applied', async () => {
    const { result, unmount } = await mountUntilFinalBookRead();

    await act(async () => {
      finalBook.resolve(makeBook({ status: BookStatus.Complete, updatedAt: T1 }));
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    expect(result.current.book?.status).toBe(BookStatus.Complete);

    // The one legitimate extra request: the status change re-reads diagnostics.
    // It is left pending so it can land late, below.
    expect(diagnosticsReads).toHaveLength(2);
    expect(progressReads()).toBe(1);
    expect(bookReads()).toBe(2);

    await fireRecoveryEventsAndIntervals(4);
    expect(progressReads()).toBe(1);
    expect(bookReads()).toBe(2);

    // A diagnostics response landing late must not restart polling either.
    await act(async () => {
      diagnosticsReads[1].resolve({} as GenerationDiagnosticsDto);
      await vi.advanceTimersByTimeAsync(0);
    });
    await fireRecoveryEventsAndIntervals(4);
    expect(progressReads()).toBe(1);
    expect(bookReads()).toBe(2);
    unmount();
  });

  it('ignores recovery events between applying the terminal book and the effect cleanup', async () => {
    const { result, unmount } = await mountUntilFinalBookRead();

    // Inside one act scope React queues the render that follows the book update,
    // so the old poll effect (and its listeners) is still installed while the
    // hook already holds the terminal book: the window before effect cleanup.
    await act(async () => {
      finalBook.resolve(makeBook({ status: BookStatus.Complete, updatedAt: T1 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(result.current.book?.status).toBe(BookStatus.CharBuild);

      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    await settle();

    expect(result.current.book?.status).toBe(BookStatus.Complete);
    expect(progressReads()).toBe(1);
    expect(bookReads()).toBe(2);
    unmount();
  });

  it('keeps recovering a non-terminal run after online and visibility events', async () => {
    const { result, unmount } = await mountUntilFinalBookRead();

    // Progress said terminal but the book read is still a generating book: it is
    // applied, no terminal state is reached, and a recovery event resumes polling.
    await act(async () => {
      finalBook.resolve(makeBook({ status: BookStatus.CharBuild, updatedAt: T1 }));
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    expect(result.current.book?.status).toBe(BookStatus.CharBuild);
    const progressBefore = progressReads();

    await fireRecoveryEventsAndIntervals(1);
    expect(progressReads()).toBeGreaterThan(progressBefore);
    unmount();
  });
});
