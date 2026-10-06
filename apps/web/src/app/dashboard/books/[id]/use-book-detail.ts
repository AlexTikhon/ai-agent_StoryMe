import { useCallback, useEffect, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import { BookStatus } from '@book/types';
import type { BookDto, GenerationDiagnosticsDto, GenerationProgressDto } from '@book/types';
import { booksApi } from '@/lib/api/books';
import { ApiError } from '@/lib/api/client';

const POLL_INTERVAL_MS = 2500;

function isTerminalBookStatus(status: BookStatus): boolean {
  return (
    status === BookStatus.Complete ||
    status === BookStatus.Failed ||
    status === BookStatus.Cancelled ||
    status === BookStatus.Partial
  );
}

export function isGeneratingBookStatus(status: BookStatus): boolean {
  return status !== BookStatus.Created && !isTerminalBookStatus(status);
}

/**
 * Freshness rule shared by every book response (initial load, polling, manual
 * refresh): a response for another book, or one older than what is on screen,
 * never replaces the current book. A cancelled book is only replaced by a
 * strictly newer record so a response that raced the cancellation can't undo it.
 */
export function shouldAcceptBook(current: BookDto | null, incoming: BookDto): boolean {
  if (!current) return true;
  if (current.id !== incoming.id) return false;
  const currentAt = Date.parse(current.updatedAt);
  const incomingAt = Date.parse(incoming.updatedAt);
  if (Number.isNaN(currentAt) || Number.isNaN(incomingAt)) return true;
  return current.status === BookStatus.Cancelled ? incomingAt > currentAt : incomingAt >= currentAt;
}

/**
 * Owns fetching a book by id, polling it while actively generating, optional
 * developer-diagnostics reads, and the manual "Refresh status" action. Other
 * mutations (edit/generate/regenerate/delete) live in the page component and
 * call `setBook` directly with the response they already got back from their
 * own API call, rather than re-fetching here.
 */
export function useBookDetail(id: string, enableDeveloperDiagnostics: boolean) {
  const [book, setBookState] = useState<BookDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const [diagnostics, setDiagnostics] = useState<GenerationDiagnosticsDto | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [progress, setProgress] = useState<GenerationProgressDto | null>(null);

  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Request coordinator. `bookRef` mirrors the on-screen book synchronously so
  // freshness checks never read a stale render closure; `routeRef` is bumped
  // whenever the route (or load attempt) changes so late responses for a
  // previous route are dropped; `refreshControllerRef` is both the in-flight
  // guard and the cancellation handle for the manual refresh.
  const bookRef = useRef<BookDto | null>(null);
  const routeRef = useRef(0);
  const refreshControllerRef = useRef<AbortController | null>(null);

  const setBook = useCallback((value: SetStateAction<BookDto | null>) => {
    const next = typeof value === 'function' ? value(bookRef.current) : value;
    bookRef.current = next;
    setBookState(next);
  }, []);

  /** The single entry point for fetched (non-mutation) book responses. */
  const applyBook = useCallback(
    (incoming: BookDto): boolean => {
      if (!shouldAcceptBook(bookRef.current, incoming)) return false;
      setBook(incoming);
      return true;
    },
    [setBook],
  );

  useEffect(() => {
    let cancelled = false;
    routeRef.current += 1;
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
    setRefreshing(false);
    setRefreshError(null);
    setLoading(true);
    setLoadError(null);
    setNotFound(false);
    setBook(null);
    setProgress(null);

    const controller = new AbortController();
    booksApi
      .get(id, controller.signal)
      .then((data) => {
        if (!cancelled) {
          setBook(data);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          if (err instanceof ApiError && err.status === 404) {
            setNotFound(true);
          } else {
            setLoadError(err instanceof Error ? err.message : 'Failed to load book');
          }
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      routeRef.current += 1;
      controller.abort();
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
    };
  }, [id, loadAttempt, setBook]);

  // The Book status intentionally remains coarse. Fetch the authoritative
  // GenerationRun projection as soon as an active run appears so ordinary
  // users see only stages that the worker durably recorded.
  useEffect(() => {
    if (!book || !isGeneratingBookStatus(book.status)) {
      setProgress(null);
      return;
    }
    setProgress(null);
  }, [id, book?.status]);

  // One cancellable in-flight loop. During generation it fetches only the
  // compact durable progress projection; a terminal projection triggers one
  // full-book read so content/publication changes arrive together.
  useEffect(() => {
    if (!book || !isGeneratingBookStatus(book.status)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // At most one poll request is ever in flight; the chain reschedules itself
    // when the request settles, so recovery events must not start a second one.
    let inFlight: AbortController | undefined;
    let failures = 0;
    const schedule = (delay: number) => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (cancelled || inFlight) return;
      if (document.visibilityState === 'hidden' || !navigator.onLine) {
        schedule(POLL_INTERVAL_MS);
        return;
      }
      const requestController = new AbortController();
      inFlight = requestController;
      try {
        const data = await booksApi.getGenerationProgress(id, requestController.signal);
        if (cancelled) return;
        failures = 0;
        setProgress(data);
        if (['complete', 'failed', 'cancelled'].includes(data.status)) {
          const full = await booksApi.get(id, requestController.signal);
          if (cancelled || full.id !== id) return;
          applyBook(full);
          return;
        }
        schedule(POLL_INTERVAL_MS);
      } catch {
        if (cancelled || requestController.signal.aborted) return;
        failures += 1;
        const backoff = Math.min(30_000, POLL_INTERVAL_MS * 2 ** Math.min(failures, 3));
        schedule(Math.round(backoff * (0.8 + Math.random() * 0.4)));
      } finally {
        if (inFlight === requestController) inFlight = undefined;
      }
    };
    const recover = () => {
      if (cancelled || inFlight || document.visibilityState === 'hidden' || !navigator.onLine) {
        return;
      }
      schedule(0);
    };
    document.addEventListener('visibilitychange', recover);
    window.addEventListener('online', recover);
    schedule(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      inFlight?.abort();
      document.removeEventListener('visibilitychange', recover);
      window.removeEventListener('online', recover);
    };
  }, [id, book?.id, book?.status, applyBook]);

  // Fetch diagnostics once generation has started (not for untouched drafts)
  useEffect(() => {
    if (!enableDeveloperDiagnostics || !book || book.status === BookStatus.Created) return;
    let cancelled = false;
    booksApi
      .getGenerationDiagnostics(id)
      .then((data) => {
        if (!cancelled) {
          setDiagnostics(data);
          setDiagnosticsError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDiagnosticsError(err instanceof Error ? err.message : 'Failed to load diagnostics');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, book?.status, enableDeveloperDiagnostics]);

  const handleRefresh = useCallback(async () => {
    if (refreshControllerRef.current) return;
    const controller = new AbortController();
    refreshControllerRef.current = controller;
    const route = routeRef.current;
    const owns = () => routeRef.current === route && !controller.signal.aborted;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const data = await booksApi.get(id, controller.signal);
      if (!owns()) return;
      // A response older than what is on screen (e.g. a mutation landed while
      // this request was in flight) is dropped along with its derived reads.
      if (!applyBook(data)) return;
      if (isGeneratingBookStatus(data.status)) {
        try {
          const progressData = await booksApi.getGenerationProgress(id, controller.signal);
          if (!owns()) return;
          setProgress(progressData);
        } catch {
          if (!owns()) return;
          setProgress(null);
        }
      } else {
        setProgress(null);
      }
      if (enableDeveloperDiagnostics) {
        try {
          const diagnosticsData = await booksApi.getGenerationDiagnostics(id, controller.signal);
          if (!owns()) return;
          setDiagnostics(diagnosticsData);
          setDiagnosticsError(null);
        } catch (err) {
          if (!owns()) return;
          setDiagnosticsError(err instanceof Error ? err.message : 'Failed to load diagnostics');
        }
      }
    } catch (err) {
      if (owns()) {
        setRefreshError(err instanceof Error ? err.message : 'Failed to refresh status');
      }
    } finally {
      if (refreshControllerRef.current === controller) {
        refreshControllerRef.current = null;
        setRefreshing(false);
      }
    }
  }, [id, enableDeveloperDiagnostics, applyBook]);

  const retryLoad = () => setLoadAttempt((n) => n + 1);

  return {
    book,
    setBook,
    applyBook,
    loading,
    loadError,
    notFound,
    retryLoad,
    progress,
    diagnostics,
    diagnosticsError,
    refreshing,
    refreshError,
    handleRefresh,
  };
}
