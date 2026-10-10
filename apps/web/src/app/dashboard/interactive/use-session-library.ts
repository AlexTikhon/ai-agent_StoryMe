'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { InteractiveSessionListDto, InteractiveSessionSummaryDto } from '@book/types';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { getSessionEpoch } from '@/lib/auth/token-store';

export const LIBRARY_PAGE_SIZE = 20;
/** Local deadline per request; cancelling stops waiting, not necessarily server work. */
export const LIBRARY_DEADLINE_MS = 15_000;

export type LibraryPhase = 'loading' | 'ready' | 'error';
export type LibraryErrorKind = 'rate-limited' | 'failed';

interface LibraryData {
  phase: LibraryPhase;
  sessions: InteractiveSessionSummaryDto[];
  nextCursor: string | null;
  /** A first-page request (initial load or manual refresh) is in flight. */
  refreshing: boolean;
  /** A refresh failed while an earlier list is still shown. */
  refreshFailed: boolean;
  loadingMore: boolean;
  loadMoreFailed: boolean;
  error: LibraryErrorKind | null;
}

const INITIAL: LibraryData = {
  phase: 'loading',
  sessions: [],
  nextCursor: null,
  refreshing: false,
  refreshFailed: false,
  loadingMore: false,
  loadMoreFailed: false,
  error: null,
};

/**
 * What every async completion is bound to. Work for any other scope (another
 * account, an earlier auth session, an unmounted page) is dropped, and
 * `generation` invalidates in-flight requests of the same scope: a refresh
 * obsoletes earlier refreshes and any pagination started before it.
 */
interface Scope {
  readonly userId: string;
  readonly epoch: number;
  generation: number;
  readonly controllers: Set<AbortController>;
}

function errorKind(cause: unknown): LibraryErrorKind {
  return cause instanceof ApiError && cause.status === 429 ? 'rate-limited' : 'failed';
}

function appendUnique(
  current: InteractiveSessionSummaryDto[],
  incoming: InteractiveSessionSummaryDto[],
): InteractiveSessionSummaryDto[] {
  const seen = new Set(current.map((s) => s.sessionId));
  return [...current, ...incoming.filter((s) => !seen.has(s.sessionId))];
}

/**
 * The signed-in user's stories, newest first, in pages. The list is read-only
 * server data: nothing is cached across accounts or reloads.
 */
export function useSessionLibrary() {
  const { status, user } = useAuth();
  const userId = status === 'authed' ? (user?.id ?? null) : null;

  // The owner is stored with the data so another account's list can never be
  // rendered, not even for the render before the reset effect runs.
  const [store, setStore] = useState<{ ownerId: string | null; data: LibraryData }>({
    ownerId: null,
    data: INITIAL,
  });
  const data = store.ownerId !== null && store.ownerId === userId ? store.data : INITIAL;

  const scopeRef = useRef<Scope | null>(null);
  const dataRef = useRef<LibraryData>(INITIAL);
  const loadingMoreRef = useRef(false);

  const isCurrent = useCallback(
    (scope: Scope) => scopeRef.current === scope && getSessionEpoch() === scope.epoch,
    [],
  );

  const commit = useCallback((scope: Scope, update: (current: LibraryData) => LibraryData) => {
    const next = update(dataRef.current);
    dataRef.current = next;
    setStore({ ownerId: scope.userId, data: next });
  }, []);

  const abortRequests = useCallback((scope: Scope) => {
    for (const controller of scope.controllers) controller.abort();
    scope.controllers.clear();
  }, []);

  const fetchPage = useCallback(
    async (scope: Scope, cursor: string | null): Promise<InteractiveSessionListDto> => {
      const controller = new AbortController();
      scope.controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), LIBRARY_DEADLINE_MS);
      try {
        return await interactiveApi.listSessions(
          { limit: LIBRARY_PAGE_SIZE, cursor },
          controller.signal,
        );
      } finally {
        clearTimeout(timer);
        scope.controllers.delete(controller);
      }
    },
    [],
  );

  /** Reloads the first page. Obsoletes every earlier refresh and any pagination in flight. */
  const refresh = useCallback(async () => {
    const scope = scopeRef.current;
    if (!scope) return;
    const generation = ++scope.generation;
    abortRequests(scope);
    loadingMoreRef.current = false;
    commit(scope, (d) => ({
      ...d,
      refreshing: true,
      refreshFailed: false,
      loadingMore: false,
      loadMoreFailed: false,
    }));
    try {
      const page = await fetchPage(scope, null);
      if (!isCurrent(scope) || scope.generation !== generation) return;
      commit(scope, () => ({
        ...INITIAL,
        phase: 'ready',
        sessions: page.sessions,
        nextCursor: page.nextCursor,
      }));
    } catch (cause) {
      if (!isCurrent(scope) || scope.generation !== generation) return;
      const error = errorKind(cause);
      commit(scope, (d) =>
        d.phase === 'ready'
          ? { ...d, refreshing: false, refreshFailed: true, error }
          : { ...d, phase: 'error', refreshing: false, error },
      );
    }
  }, [abortRequests, commit, fetchPage, isCurrent]);

  /** Appends the next page; a no-op while another request is running or there is no next page. */
  const loadMore = useCallback(async () => {
    const scope = scopeRef.current;
    const current = dataRef.current;
    if (!scope || loadingMoreRef.current) return;
    if (current.phase !== 'ready' || current.refreshing || !current.nextCursor) return;
    loadingMoreRef.current = true;
    const generation = scope.generation;
    commit(scope, (d) => ({ ...d, loadingMore: true, loadMoreFailed: false }));
    try {
      const page = await fetchPage(scope, current.nextCursor);
      if (!isCurrent(scope) || scope.generation !== generation) return;
      commit(scope, (d) => ({
        ...d,
        sessions: appendUnique(d.sessions, page.sessions),
        nextCursor: page.nextCursor,
        loadingMore: false,
      }));
    } catch (cause) {
      if (!isCurrent(scope) || scope.generation !== generation) return;
      commit(scope, (d) => ({
        ...d,
        loadingMore: false,
        loadMoreFailed: true,
        error: errorKind(cause),
      }));
    } finally {
      // A refresh that obsoleted this request already reset the flag.
      if (scope.generation === generation) loadingMoreRef.current = false;
    }
  }, [commit, fetchPage, isCurrent]);

  // A new scope per account/auth session: the previous one is orphaned and its
  // requests aborted before the new account's list is requested.
  useEffect(() => {
    dataRef.current = INITIAL;
    loadingMoreRef.current = false;
    if (!userId) {
      scopeRef.current = null;
      setStore({ ownerId: null, data: INITIAL });
      return;
    }
    const scope: Scope = {
      userId,
      epoch: getSessionEpoch(),
      generation: 0,
      controllers: new Set(),
    };
    scopeRef.current = scope;
    setStore({ ownerId: userId, data: INITIAL });
    void refresh();
    return () => {
      scope.generation += 1;
      abortRequests(scope);
      if (scopeRef.current === scope) scopeRef.current = null;
    };
  }, [userId, refresh, abortRequests]);

  return { ...data, refresh, loadMore };
}
