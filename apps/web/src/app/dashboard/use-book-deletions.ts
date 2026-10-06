import { useCallback, useEffect, useState } from 'react';
import type { BookDeletionRequestDto, BookDeletionStatus } from '@book/types';
import { booksApi } from '@/lib/api/books';

const POLL_INTERVAL_MS = 2500;
const MAX_FAILURE_BACKOFF_MS = 15_000;

export interface TrackedDeletion {
  request: BookDeletionRequestDto;
  /** Known only for deletions started in this session; the API never returns titles. */
  title: string | null;
}

/** Statuses the worker is still driving — everything else needs the user or is finished. */
export function isDeletionInProgress(status: BookDeletionStatus): boolean {
  return status === 'requested' || status === 'processing';
}

/**
 * Tracks permanent-deletion requests through their asynchronous lifecycle
 * (requested → processing → retry_pending | completed). The API tombstones a
 * book immediately but erases its data and artifacts in the background, so a
 * 202 is not "deleted": this hook keeps the request, polls it until it settles,
 * restores unfinished requests after a reload, and lets the caller resubmit a
 * stalled one.
 */
export function useBookDeletions() {
  const [deletions, setDeletions] = useState<TrackedDeletion[]>([]);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const upsert = useCallback((request: BookDeletionRequestDto, title?: string | null) => {
    setDeletions((current) => {
      const index = current.findIndex((item) => item.request.bookId === request.bookId);
      if (index === -1) return [{ request, title: title ?? null }, ...current];
      const existing = current[index]!;
      // A finished deletion is final; a late poll/list response must not revive it.
      if (existing.request.status === 'completed') return current;
      const next = current.slice();
      next[index] = { request, title: title ?? existing.title };
      return next;
    });
  }, []);

  /**
   * Starts a deletion, or re-queues a stalled one — the endpoint is idempotent
   * per book. Throws when the API rejects the request so the caller can report it.
   */
  const requestDeletion = useCallback(
    async (bookId: string, title: string | null): Promise<BookDeletionRequestDto> => {
      const request = await booksApi.requestHardDelete(bookId);
      upsert(request, title);
      return request;
    },
    [upsert],
  );

  const dismiss = useCallback((bookId: string) => {
    setDeletions((current) => current.filter((item) => item.request.bookId !== bookId));
  }, []);

  // Restore unfinished requests after a reload / navigation.
  useEffect(() => {
    const controller = new AbortController();
    booksApi
      .listPendingDeletions(controller.signal)
      .then((pending) => {
        if (controller.signal.aborted) return;
        setRestoreError(null);
        // Newest first from the API; upsert prepends, so apply oldest first.
        for (const request of [...pending].reverse()) upsert(request);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setRestoreError(err instanceof Error ? err.message : 'Could not check pending deletions');
      });
    return () => controller.abort();
  }, [upsert]);

  // One polling chain for every in-progress request. Restarted only when the
  // set of in-progress ids changes, never while a request is still pending.
  const inProgressKey = deletions
    .filter((item) => isDeletionInProgress(item.request.status))
    .map((item) => item.request.id)
    .sort()
    .join(',');

  useEffect(() => {
    if (!inProgressKey) return;
    const ids = inProgressKey.split(',');
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    let failures = 0;

    const schedule = (delay: number) => {
      if (!cancelled) timer = setTimeout(() => void tick(), delay);
    };
    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === 'hidden' || !navigator.onLine) {
        schedule(POLL_INTERVAL_MS);
        return;
      }
      let failed = false;
      await Promise.all(
        ids.map(async (requestId) => {
          try {
            const next = await booksApi.getDeletionStatus(requestId, controller.signal);
            if (!cancelled) upsert(next);
          } catch {
            if (!controller.signal.aborted) failed = true;
          }
        }),
      );
      if (cancelled) return;
      failures = failed ? failures + 1 : 0;
      schedule(
        failed
          ? Math.min(MAX_FAILURE_BACKOFF_MS, POLL_INTERVAL_MS * 2 ** Math.min(failures, 3))
          : POLL_INTERVAL_MS,
      );
    };

    schedule(POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      controller.abort();
    };
  }, [inProgressKey, upsert]);

  return { deletions, restoreError, requestDeletion, dismiss };
}
