import { useEffect, useState } from 'react';
import { BookStatus } from '@book/types';
import type { BookDto, GenerationDiagnosticsDto } from '@book/types';
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
 * Owns fetching a book by id, polling it (plus generation diagnostics) while
 * it's actively generating, and the manual "Refresh status" action. Other
 * mutations (edit/generate/regenerate/delete) live in the page component and
 * call `setBook` directly with the response they already got back from their
 * own API call, rather than re-fetching here.
 */
export function useBookDetail(id: string) {
  const [book, setBook] = useState<BookDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const [diagnostics, setDiagnostics] = useState<GenerationDiagnosticsDto | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);

  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setNotFound(false);
    setBook(null);

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

  // Poll while book is in a non-terminal generation state
  useEffect(() => {
    if (!book || !isGeneratingBookStatus(book.status)) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void booksApi
        .get(id)
        .then((data) => {
          if (!cancelled) setBook(data);
        })
        .catch(() => {});
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
            setDiagnosticsError(err instanceof Error ? err.message : 'Failed to load diagnostics');
          }
        });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, book?.status]);

  // Fetch diagnostics once generation has started (not for untouched drafts)
  useEffect(() => {
    if (!book || book.status === BookStatus.Created) return;
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
  }, [id, book?.status]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const data = await booksApi.get(id);
      setBook(data);
      try {
        const diagnosticsData = await booksApi.getGenerationDiagnostics(id);
        setDiagnostics(diagnosticsData);
        setDiagnosticsError(null);
      } catch (err) {
        setDiagnosticsError(err instanceof Error ? err.message : 'Failed to load diagnostics');
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
    diagnostics,
    diagnosticsError,
    refreshing,
    handleRefresh,
  };
}
