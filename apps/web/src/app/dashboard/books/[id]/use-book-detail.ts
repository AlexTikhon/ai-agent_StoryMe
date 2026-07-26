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

    booksApi
      .get(id)
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
    let cancelled = false;
    setProgress(null);
    void booksApi
      .getGenerationProgress(id)
      .then((data) => {
        if (!cancelled) setProgress(data);
      })
      .catch(() => {
        // A generic in-progress message remains truthful if this optional
        // projection cannot be loaded.
      });
    return () => {
      cancelled = true;
    };
  }, [id, book?.status]);

  // Poll while book is in a non-terminal generation state
  useEffect(() => {
    if (!book || !isGeneratingBookStatus(book.status)) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void booksApi
        .get(id)
        .then((data) => {
          if (cancelled) return;
          // A user-initiated POST /:id/cancel response can land while this
          // poll is already in flight. Reading `current` here (rather than
          // the `book` closed over by this effect) always reflects the
          // latest committed state, so a stale non-cancelled poll response
          // can never clobber an already-applied cancellation.
          setBook((current) => (current?.status === BookStatus.Cancelled ? current : data));
        })
        .catch(() => {});
      void booksApi
        .getGenerationProgress(id)
        .then((data) => {
          if (!cancelled) setProgress(data);
        })
        .catch(() => {});
      if (enableDeveloperDiagnostics) {
        void booksApi
          .getGenerationDiagnostics(id)
          .then((data) => {
            if (!cancelled) {
              setDiagnostics(data);
              setDiagnosticsError(null);
            }
          })
          .catch((err: unknown) => {
            if (!cancelled) {
              setDiagnosticsError(
                err instanceof Error ? err.message : 'Failed to load diagnostics',
              );
            }
          });
      }
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, book?.status, enableDeveloperDiagnostics]);

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
