'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { InteractiveTranscriptStepDto } from '@book/types';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { getSessionEpoch } from '@/lib/auth/token-store';
import { describeAcceptedPage, type AcceptedTranscriptPage } from './accepted-page';
import { checkTranscriptPage, type TranscriptIdentity } from './validate-transcript-page';

/** Steps requested per page, so even the short published routes need more than one page. */
export const TRANSCRIPT_PAGE_SIZE = 3;
/** Local deadline per request; cancelling stops waiting, not necessarily server work. */
export const TRANSCRIPT_DEADLINE_MS = 15_000;

/**
 * loading        – the first page is in flight.
 * ready          – at least one validated page is shown.
 * error          – the first page failed; nothing is shown yet.
 * unavailable    – missing or foreign session (indistinguishable on purpose).
 * not-completed  – the story is still in progress; rereading comes after the ending.
 * auth-required  – the shared auth layer owns the redirect.
 */
export type TranscriptPhase =
  'loading' | 'ready' | 'error' | 'unavailable' | 'not-completed' | 'auth-required';

/** Why the last request for the next cursor did not add a page. */
export type TranscriptFailure = 'rate-limited' | 'failed' | 'inconsistent';

interface TranscriptData {
  phase: TranscriptPhase;
  chapters: InteractiveTranscriptStepDto[];
  /** One frozen descriptor per accepted text page, oldest first; artwork is requested from these. */
  pages: readonly AcceptedTranscriptPage[];
  identity: (TranscriptIdentity & { sessionId: string }) | null;
  /** The cursor of the next page; `null` once the terminal step is loaded. */
  nextCursor: string | null;
  /** A request is in flight (the first page while `phase` is `loading`, later pages otherwise). */
  loadingMore: boolean;
  /** The last request failed; the same cursor is retried by the next `loadNext`. */
  failure: TranscriptFailure | null;
}

const INITIAL: TranscriptData = {
  phase: 'loading',
  chapters: [],
  pages: [],
  identity: null,
  nextCursor: null,
  loadingMore: false,
  failure: null,
};

/**
 * What every async completion is bound to. Work for any other scope (another
 * session, another account, an earlier auth session, an unmounted page) is dropped.
 */
interface Scope {
  readonly key: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly controllers: Set<AbortController>;
  readonly usedCursors: Set<string>;
  /** Synchronous single-flight guard: a disabled button alone is not enough. */
  inFlight: boolean;
}

function failureKind(error: unknown): TranscriptFailure {
  return error instanceof ApiError && error.status === 429 ? 'rate-limited' : 'failed';
}

/**
 * The chapters of one completed story, oldest first, in explicit pages.
 *
 * Only the first page is requested automatically; every further page needs
 * `loadNext`. Each response is validated against what is already shown before
 * it is appended, so history can be neither duplicated, skipped, reordered nor
 * mixed with another story, and a failed request never discards what is loaded.
 * Read-only: it never creates a session or submits a choice.
 */
export function useInteractiveTranscript(sessionId: string) {
  const { status: authStatus, user } = useAuth();
  const userId = authStatus === 'authed' ? (user?.id ?? null) : null;
  const key = userId !== null ? `${sessionId}|${userId}|e${getSessionEpoch()}` : null;

  // The data is stored with the scope it belongs to, so another session's,
  // account's or login's chapters are never rendered, not even for the render
  // before the reset effect runs.
  const [store, setStore] = useState<{ key: string | null; data: TranscriptData }>({
    key: null,
    data: INITIAL,
  });
  const data = key !== null && store.key === key ? store.data : INITIAL;

  const scopeRef = useRef<Scope | null>(null);
  const dataRef = useRef<TranscriptData>(INITIAL);

  const isCurrent = useCallback(
    (scope: Scope) => scopeRef.current === scope && getSessionEpoch() === scope.epoch,
    [],
  );

  const commit = useCallback(
    (scope: Scope, update: (current: TranscriptData) => TranscriptData) => {
      const next = update(dataRef.current);
      dataRef.current = next;
      setStore({ key: scope.key, data: next });
    },
    [],
  );

  const requestPage = useCallback(
    async (scope: Scope) => {
      if (scope.inFlight || !isCurrent(scope)) return;
      const current = dataRef.current;
      const first = current.chapters.length === 0;
      if (!first && current.nextCursor === null) return; // nothing left to load
      const cursor = first ? null : current.nextCursor;

      scope.inFlight = true;
      commit(scope, (d) => ({ ...d, loadingMore: true, failure: null }));
      const controller = new AbortController();
      scope.controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), TRANSCRIPT_DEADLINE_MS);
      try {
        const raw: unknown = await interactiveApi.getTranscript(
          scope.sessionId,
          { limit: TRANSCRIPT_PAGE_SIZE, cursor },
          controller.signal,
        );
        if (!isCurrent(scope)) return;
        const checked = checkTranscriptPage(raw, {
          sessionId: scope.sessionId,
          limit: TRANSCRIPT_PAGE_SIZE,
          nextRevision: first ? 0 : current.chapters[current.chapters.length - 1]!.revision + 1,
          identity: current.identity,
          requestedCursor: cursor,
          usedCursors: scope.usedCursors,
        });
        if (!checked.ok) {
          commit(scope, (d) => ({
            ...d,
            phase: d.chapters.length === 0 ? 'error' : d.phase,
            loadingMore: false,
            failure: 'inconsistent',
          }));
          return;
        }
        const { page } = checked;
        if (cursor !== null) scope.usedCursors.add(cursor);
        commit(scope, (d) => ({
          phase: 'ready',
          chapters: [...d.chapters, ...page.steps],
          pages: [...d.pages, describeAcceptedPage(page, { limit: TRANSCRIPT_PAGE_SIZE, cursor })],
          identity: {
            sessionId: page.sessionId,
            scenarioId: page.scenarioId,
            scenarioVersion: page.scenarioVersion,
            completedRevision: page.completedRevision,
          },
          nextCursor: page.nextCursor,
          loadingMore: false,
          failure: null,
        }));
      } catch (error) {
        if (!isCurrent(scope)) return;
        if (error instanceof ApiError && error.code === 'SESSION_NOT_FOUND') {
          commit(scope, () => ({ ...INITIAL, phase: 'unavailable' }));
        } else if (error instanceof ApiError && error.code === 'SESSION_NOT_COMPLETED') {
          commit(scope, () => ({ ...INITIAL, phase: 'not-completed' }));
        } else if (error instanceof ApiError && error.status === 401) {
          // apiFetch already tried the refresh flow; the shared auth layer owns the redirect.
          commit(scope, () => ({ ...INITIAL, phase: 'auth-required' }));
        } else {
          commit(scope, (d) => ({
            ...d,
            phase: d.chapters.length === 0 ? 'error' : d.phase,
            loadingMore: false,
            failure: failureKind(error),
          }));
        }
      } finally {
        clearTimeout(timer);
        scope.controllers.delete(controller);
        scope.inFlight = false;
      }
    },
    [commit, isCurrent],
  );

  /** Requests the page after the loaded history, or retries the exact cursor that just failed. */
  const loadNext = useCallback(() => {
    const scope = scopeRef.current;
    if (scope) void requestPage(scope);
  }, [requestPage]);

  // A new scope per session, account and login: the previous one is orphaned and
  // its requests aborted before anything is requested for the new one.
  useEffect(() => {
    dataRef.current = INITIAL;
    if (key === null || userId === null) {
      scopeRef.current = null;
      setStore({ key: null, data: INITIAL });
      return;
    }
    const scope: Scope = {
      key,
      sessionId,
      epoch: getSessionEpoch(),
      controllers: new Set(),
      usedCursors: new Set(),
      inFlight: false,
    };
    scopeRef.current = scope;
    setStore({ key, data: INITIAL });
    void requestPage(scope);
    return () => {
      if (scopeRef.current === scope) scopeRef.current = null;
      for (const controller of scope.controllers) controller.abort();
      scope.controllers.clear();
    };
  }, [key, userId, sessionId, requestPage]);

  const complete = data.phase === 'ready' && data.nextCursor === null;
  // The scope the shown chapters belong to; `null` until they do, so dependants clear in the same render.
  const scopeKey = key !== null && store.key === key ? key : null;
  return { ...data, complete, scopeKey, loadNext };
}
