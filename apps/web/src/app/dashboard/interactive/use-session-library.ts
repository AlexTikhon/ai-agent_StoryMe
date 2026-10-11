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

/** Local deadline for one removal request; giving up waiting does not undo server work. */
export const REMOVAL_DEADLINE_MS = 15_000;

export type LibraryPhase = 'loading' | 'ready' | 'error';
export type LibraryErrorKind = 'rate-limited' | 'failed';
/** `timeout` and `network` are ambiguous outcomes; `rejected` is definitive and not retryable. */
export type RemovalErrorKind = 'timeout' | 'network' | 'rate-limited' | 'unavailable' | 'rejected';

/**
 * The one removal the library is working on. `story` and `sessionId` are captured
 * when the confirmation opens and are what confirm and retry act on.
 */
export interface RemovalState {
  readonly sessionId: string;
  readonly story: InteractiveSessionSummaryDto;
  readonly status: 'confirming' | 'removing' | 'failed';
  readonly error: RemovalErrorKind | null;
}

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
  removal: RemovalState | null;
  /** The story whose removal the server last acknowledged (for the confirmation notice). */
  removed: InteractiveSessionSummaryDto | null;
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
  removal: null,
  removed: null,
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
  /**
   * The removal request in flight. Kept apart from `controllers` so a refresh
   * abandons its own requests without cancelling the wait for a removal.
   */
  removalAttempt: { readonly controller: AbortController } | null;
}

function errorKind(cause: unknown): LibraryErrorKind {
  return cause instanceof ApiError && cause.status === 429 ? 'rate-limited' : 'failed';
}

function removalErrorKind(cause: unknown): RemovalErrorKind {
  if (cause instanceof ApiError) {
    if (cause.status === 429) return 'rate-limited';
    return cause.status >= 500 ? 'unavailable' : 'rejected';
  }
  // Only this hook's own deadline aborts a removal (scope teardown ignores the result).
  // Matched by name: a DOMException is not reliably `instanceof Error` across realms.
  const name =
    typeof cause === 'object' && cause !== null ? (cause as { name?: unknown }).name : null;
  return name === 'AbortError' ? 'timeout' : 'network';
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
  // The auth epoch is part of the owner: the same account in a new auth session
  // (logout, then login) is a different scope and must not inherit state.
  const epoch = getSessionEpoch();
  const [store, setStore] = useState<{
    ownerId: string | null;
    epoch: number;
    data: LibraryData;
  }>({ ownerId: null, epoch, data: INITIAL });
  const data =
    store.ownerId !== null && store.ownerId === userId && store.epoch === epoch
      ? store.data
      : INITIAL;

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
    setStore({ ownerId: scope.userId, epoch: scope.epoch, data: next });
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
      commit(scope, (d) => ({
        ...INITIAL,
        phase: 'ready',
        sessions: page.sessions,
        nextCursor: page.nextCursor,
        // A removal in flight survives the reload; a question or failure about a
        // story that is no longer listed has nothing left to act on.
        removal:
          d.removal &&
          (d.removal.status === 'removing' ||
            page.sessions.some((s) => s.sessionId === d.removal?.sessionId))
            ? d.removal
            : null,
        removed: d.removed,
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

  /** Opens the confirmation for a listed story. Nothing is sent until `confirmRemoval`. */
  const requestRemoval = useCallback(
    (sessionId: string) => {
      const scope = scopeRef.current;
      const current = dataRef.current;
      if (!scope || !isCurrent(scope) || scope.removalAttempt) return;
      if (current.phase !== 'ready' || current.removal?.status === 'removing') return;
      const story = current.sessions.find((s) => s.sessionId === sessionId);
      if (!story) return;
      commit(scope, (d) => ({
        ...d,
        removal: { sessionId, story, status: 'confirming', error: null },
        removed: null,
      }));
    },
    [commit, isCurrent],
  );

  /** Closes a confirmation or dismisses a failure. Never cancels a request in flight. */
  const cancelRemoval = useCallback(() => {
    const scope = scopeRef.current;
    if (!scope || !isCurrent(scope) || scope.removalAttempt) return;
    if (dataRef.current.removal?.status === 'removing') return;
    commit(scope, (d) => ({ ...d, removal: null }));
  }, [commit, isCurrent]);

  /** Sends one DELETE for `removal.sessionId`; the row stays until it is acknowledged. */
  const sendRemoval = useCallback(
    (scope: Scope, removal: RemovalState) => {
      if (scope.removalAttempt) return;
      const attempt = { controller: new AbortController() };
      scope.removalAttempt = attempt;
      const timer = setTimeout(() => attempt.controller.abort(), REMOVAL_DEADLINE_MS);
      const live = () => isCurrent(scope) && scope.removalAttempt === attempt;
      commit(scope, (d) => ({ ...d, removal: { ...removal, status: 'removing', error: null } }));

      interactiveApi
        .removeSession(removal.sessionId, attempt.controller.signal)
        .then(() => {
          if (!live()) return;
          scope.removalAttempt = null;
          // Gone at once, whatever the reload says; the reload below also obsoletes
          // every refresh and pagination request that started before this point.
          commit(scope, (d) => ({
            ...d,
            sessions: d.sessions.filter((s) => s.sessionId !== removal.sessionId),
            removal: null,
            removed: removal.story,
            loadingMore: false,
            loadMoreFailed: false,
          }));
          void refresh();
        })
        .catch((cause: unknown) => {
          if (!live()) return;
          scope.removalAttempt = null;
          const error = removalErrorKind(cause);
          commit(scope, (d) => ({ ...d, removal: { ...removal, status: 'failed', error } }));
        })
        .finally(() => clearTimeout(timer));
    },
    [commit, isCurrent, refresh],
  );

  /** Confirms the removal opened by `requestRemoval`, for exactly that session. */
  const confirmRemoval = useCallback(() => {
    const scope = scopeRef.current;
    const removal = dataRef.current.removal;
    if (!scope || !isCurrent(scope) || removal?.status !== 'confirming') return;
    sendRemoval(scope, removal);
  }, [isCurrent, sendRemoval]);

  /** Resends the removal that failed, for the same session; ignored for a definitive rejection. */
  const retryRemoval = useCallback(() => {
    const scope = scopeRef.current;
    const removal = dataRef.current.removal;
    if (!scope || !isCurrent(scope) || removal?.status !== 'failed') return;
    if (removal.error === 'rejected') return;
    sendRemoval(scope, removal);
  }, [isCurrent, sendRemoval]);

  // A new scope per account/auth session: the previous one is orphaned and its
  // requests aborted before the new account's list is requested.
  useEffect(() => {
    dataRef.current = INITIAL;
    loadingMoreRef.current = false;
    if (!userId) {
      scopeRef.current = null;
      setStore({ ownerId: null, epoch, data: INITIAL });
      return;
    }
    const scope: Scope = {
      userId,
      epoch: getSessionEpoch(),
      generation: 0,
      controllers: new Set(),
      removalAttempt: null,
    };
    scopeRef.current = scope;
    setStore({ ownerId: userId, epoch: scope.epoch, data: INITIAL });
    void refresh();
    return () => {
      scope.generation += 1;
      abortRequests(scope);
      scope.removalAttempt?.controller.abort();
      scope.removalAttempt = null;
      if (scopeRef.current === scope) scopeRef.current = null;
    };
    // `epoch` is a trigger: a new auth session starts a new scope for the same account.
  }, [userId, epoch, refresh, abortRequests]);

  return {
    ...data,
    refresh,
    loadMore,
    requestRemoval,
    cancelRemoval,
    confirmRemoval,
    retryRemoval,
  };
}
