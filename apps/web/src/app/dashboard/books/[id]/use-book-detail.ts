import { useEffect, useState } from 'react';
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
 * Owns fetching a book by id, polling it while actively generating, optional
 * developer-diagnostics reads, and the manual "Refresh status" action. Other
 * mutations (edit/generate/regenerate/delete) live in the page component and
 * call `setBook` directly with the response they already got back from their
 * own API call, rather than re-fetching here.
 */
export function useBookDetail(id: string, enableDeveloperDiagnostics: boolean) {
  const [book, setBook] = useState<BookDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const [diagnostics, setDiagnostics] = useState<GenerationDiagnosticsDto | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [progress, setProgress] = useState<GenerationProgressDto | null>(null);

  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
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
      controller.abort();
    };
  }, [id, loadAttempt]);

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
    let controller: AbortController | undefined;
    let failures = 0;
    const schedule = (delay: number) => {
      if (!cancelled) timer = setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (cancelled) return;
      if (document.visibilityState === 'hidden' || !navigator.onLine) {
        schedule(POLL_INTERVAL_MS);
        return;
      }
      controller = new AbortController();
      try {
        const data = await booksApi.getGenerationProgress(id, controller.signal);
        if (cancelled) return;
        failures = 0;
        setProgress(data);
        if (['complete', 'failed', 'cancelled'].includes(data.status)) {
          const full = await booksApi.get(id, controller.signal);
          if (cancelled || full.id !== id) return;
          setBook((current) => {
            if (!current || current.id !== full.id) return current;
            if (current.status === BookStatus.Cancelled) return current;
            return new Date(full.updatedAt) >= new Date(current.updatedAt) ? full : current;
          });
          return;
        }
        schedule(POLL_INTERVAL_MS);
      } catch {
        if (cancelled || controller.signal.aborted) return;
        failures += 1;
        const backoff = Math.min(30_000, POLL_INTERVAL_MS * 2 ** Math.min(failures, 3));
        schedule(Math.round(backoff * (0.8 + Math.random() * 0.4)));
      }
    };
    const recover = () => {
      if (cancelled || document.visibilityState === 'hidden' || !navigator.onLine) return;
      if (timer) clearTimeout(timer);
      schedule(0);
    };
    document.addEventListener('visibilitychange', recover);
    window.addEventListener('online', recover);
    schedule(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', recover);
      window.removeEventListener('online', recover);
    };
  }, [id, book?.id, book?.status]);

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

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const data = await booksApi.get(id);
      setBook(data);
      if (isGeneratingBookStatus(data.status)) {
        try {
          setProgress(await booksApi.getGenerationProgress(id));
        } catch {
          setProgress(null);
        }
      } else {
        setProgress(null);
      }
      if (enableDeveloperDiagnostics) {
        try {
          const diagnosticsData = await booksApi.getGenerationDiagnostics(id);
          setDiagnostics(diagnosticsData);
          setDiagnosticsError(null);
        } catch (err) {
          setDiagnosticsError(err instanceof Error ? err.message : 'Failed to load diagnostics');
        }
      }
    } catch {
      // silent — manual retry; load errors handled by main effect
    } finally {
      setRefreshing(false);
    }
  };

  const retryLoad = () => setLoadAttempt((n) => n + 1);

  return {
    book,
    setBook,
    loading,
    loadError,
    notFound,
    retryLoad,
    progress,
    diagnostics,
    diagnosticsError,
    refreshing,
    handleRefresh,
  };
}
