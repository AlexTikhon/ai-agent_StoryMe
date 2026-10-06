import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { BookStatus } from '@book/types';
import type { BookDto, GenerationProgressDto } from '@book/types';
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
