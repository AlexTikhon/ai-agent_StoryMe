'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { InteractiveSessionViewDto, SubmitInteractiveChoiceInput } from '@book/types';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { getSessionEpoch } from '@/lib/auth/token-store';

/** Local deadline for every request; cancelling stops waiting, not necessarily server work. */
export const REQUEST_DEADLINE_MS = 15_000;
/** A focus/visibility refresh is skipped when the displayed state was fetched this recently. */
export const FOCUS_REFRESH_MIN_AGE_MS = 5_000;

export type ReaderPhase = 'loading' | 'ready' | 'unavailable' | 'load-error' | 'auth-required';

/**
 * submitting   – request in flight.
 * retryable    – outcome unknown or temporarily failed; only the exact original command may be resent.
 * confirming   – the server recorded the command; the current state still has to be re-read.
 * inconsistent – the server reports the key was used for a different command; nothing is resent.
 */
export type CommandPhase = 'submitting' | 'retryable' | 'confirming' | 'inconsistent';

export interface ReaderCommand {
  choiceId: string;
  phase: CommandPhase;
  message: string | null;
}

export interface ReaderState {
  phase: ReaderPhase;
  view: InteractiveSessionViewDto | null;
  loadError: string | null;
  command: ReaderCommand | null;
  /** The displayed state is known to be stale; choices stay blocked until a refresh succeeds. */
  syncRequired: boolean;
  syncing: boolean;
  syncError: string | null;
  notice: string | null;
}

const INITIAL_STATE: ReaderState = {
  phase: 'loading',
  view: null,
  loadError: null,
  command: null,
  syncRequired: false,
  syncing: false,
  syncError: null,
  notice: null,
};

/** What a reader session is bound to: late async work for any other scope is dropped. */
interface Scope {
  sessionId: string;
  authEpoch: number;
}

/** The one unresolved command. `request` is immutable for its whole life. */
interface PendingCommand {
  readonly request: Readonly<SubmitInteractiveChoiceInput>;
  attempts: number;
  phase: CommandPhase;
  /** Revision of the server's (possibly historical) answer, once the command is known to be recorded. */
  recordedRevision: number | null;
}

type RefreshOutcome = 'ok' | 'stale' | 'failed' | 'dropped';

const REJECTION_MESSAGES: Record<string, string> = {
  REVISION_CONFLICT:
    "The story moved on (perhaps in another tab), so your choice wasn't applied. Here is where it stands now.",
  CHOICE_UNAVAILABLE: 'That choice is no longer available. Here is where the story stands now.',
  UNKNOWN_CHOICE: 'That choice is no longer available. Here is where the story stands now.',
  SESSION_TERMINAL: 'This story has already ended.',
};

function describeRetryable(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'SESSION_BUSY') return 'The story is busy right now.';
    if (error.code === 'NARRATION_INVALID' || error.code === 'NARRATION_PROVIDER_FAILED') {
      return "The narrator couldn't write the next scene.";
    }
    return 'The service had a problem, so your choice may or may not have been recorded.';
  }
  return "We couldn't confirm whether your choice was recorded.";
}

function isRejection(error: ApiError): boolean {
  if (error.code && error.code in REJECTION_MESSAGES) return true;
  return error.status >= 400 && error.status < 500 && error.status !== 429;
}

export function useInteractiveReader(sessionId: string) {
  const { status: authStatus, user } = useAuth();
  const userId = user?.id ?? null;

  const [state, setState] = useState<ReaderState>(INITIAL_STATE);

  const scopeRef = useRef<Scope | null>(null);
  const viewRef = useRef<InteractiveSessionViewDto | null>(null);
  const commandRef = useRef<PendingCommand | null>(null);
  const syncRequiredRef = useRef(false);
  /** Synchronous single-flight guard for submit / retry / sync (disabled buttons alone are not enough). */
  const busyRef = useRef(false);
  const refreshRef = useRef<{ id: number; promise: Promise<RefreshOutcome> } | null>(null);
  const refreshSeqRef = useRef(0);
  const lastFetchedAtRef = useRef(0);
  const controllersRef = useRef(new Set<AbortController>());

  const patch = useCallback((next: Partial<ReaderState>) => {
    setState((current) => ({ ...current, ...next }));
  }, []);

  const isCurrent = useCallback(
    (scope: Scope) => scopeRef.current === scope && getSessionEpoch() === scope.authEpoch,
    [],
  );

  const abortAll = useCallback(() => {
    for (const controller of controllersRef.current) controller.abort();
    controllersRef.current.clear();
  }, []);

  const resetRefs = useCallback(() => {
    abortAll();
    viewRef.current = null;
    commandRef.current = null;
    syncRequiredRef.current = false;
    busyRef.current = false;
    refreshRef.current = null;
    lastFetchedAtRef.current = 0;
  }, [abortAll]);

  /** Runs one request under a local abortable deadline. */
  const withDeadline = useCallback(
    async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const controller = new AbortController();
      controllersRef.current.add(controller);
      const timer = setTimeout(() => controller.abort(), REQUEST_DEADLINE_MS);
      try {
        return await run(controller.signal);
      } finally {
        clearTimeout(timer);
        controllersRef.current.delete(controller);
      }
    },
    [],
  );

  /**
   * Displays `view` only if it is for this session and not older than what is
   * already shown: a delayed GET or a saved response for an earlier revision
   * must never move the reader backwards.
   */
  const applyView = useCallback(
    (scope: Scope, view: InteractiveSessionViewDto): 'applied' | 'stale' | 'mismatch' => {
      if (view.sessionId !== scope.sessionId) return 'mismatch';
      const shown = viewRef.current;
      if (shown && view.revision < shown.revision) return 'stale';
      viewRef.current = view;
      lastFetchedAtRef.current = Date.now();
      patch({ view, phase: 'ready', loadError: null });
      return 'applied';
    },
    [patch],
  );

  const markUnavailable = useCallback(
    (scope: Scope) => {
      if (!isCurrent(scope)) return;
      viewRef.current = null;
      commandRef.current = null;
      syncRequiredRef.current = false;
      patch({
        phase: 'unavailable',
        view: null,
        command: null,
        syncRequired: false,
        syncing: false,
        syncError: null,
      });
    },
    [isCurrent, patch],
  );

  const markAuthRequired = useCallback(
    (scope: Scope) => {
      if (!isCurrent(scope)) return;
      // apiFetch already tried the refresh flow; the shared auth layer owns the redirect.
      patch({ phase: 'auth-required', syncing: false });
    },
    [isCurrent, patch],
  );

  /** One GET of the authoritative state. `force` bypasses coalescing and the freshness guard. */
  const refresh = useCallback(
    (scope: Scope, force: boolean): Promise<RefreshOutcome> => {
      if (!force) {
        if (refreshRef.current) return refreshRef.current.promise;
        if (Date.now() - lastFetchedAtRef.current < FOCUS_REFRESH_MIN_AGE_MS) {
          return Promise.resolve('ok');
        }
      }
      const id = ++refreshSeqRef.current;
      const promise = (async (): Promise<RefreshOutcome> => {
        try {
          const view = await withDeadline((signal) =>
            interactiveApi.getSession(scope.sessionId, signal),
          );
          if (!isCurrent(scope)) return 'dropped';
          const applied = applyView(scope, view);
          if (applied === 'applied') return 'ok';
          return applied === 'stale' ? 'stale' : 'failed';
        } catch (error) {
          if (!isCurrent(scope)) return 'dropped';
          if (error instanceof ApiError && error.code === 'SESSION_NOT_FOUND') {
            markUnavailable(scope);
            return 'dropped';
          }
          if (error instanceof ApiError && error.status === 401) {
            markAuthRequired(scope);
            return 'dropped';
          }
          return 'failed';
        } finally {
          if (refreshRef.current?.id === id) refreshRef.current = null;
        }
      })();
      refreshRef.current = { id, promise };
      return promise;
    },
    [applyView, isCurrent, markAuthRequired, markUnavailable, withDeadline],
  );

  /** Forced refresh that unblocks choices only when it really returned the current state. */
  const syncAuthoritativeState = useCallback(
    async (scope: Scope) => {
      patch({ syncing: true, syncError: null });
      const outcome = await refresh(scope, true);
      if (!isCurrent(scope) || outcome === 'dropped') return;
      if (outcome === 'ok') {
        syncRequiredRef.current = false;
        patch({ syncing: false, syncRequired: false, syncError: null });
      } else {
        patch({
          syncing: false,
          syncError: "We couldn't load the latest story state. Your place is kept; try again.",
        });
      }
    },
    [isCurrent, patch, refresh],
  );

  const setCommandUi = useCallback(
    (command: PendingCommand | null, message: string | null = null) => {
      patch({
        command: command
          ? { choiceId: command.request.choiceId, phase: command.phase, message }
          : null,
      });
    },
    [patch],
  );

  /** The server recorded the command: re-read the current state before allowing anything new. */
  const confirmRecorded = useCallback(
    async (scope: Scope, command: PendingCommand, recordedRevision: number) => {
      command.phase = 'confirming';
      command.recordedRevision = recordedRevision;
      setCommandUi(command, 'Your choice was recorded. Loading the latest story state…');
      const outcome = await refresh(scope, true);
      if (!isCurrent(scope) || outcome === 'dropped') return;
      const shown = viewRef.current;
      if (outcome === 'ok' && shown && shown.revision >= recordedRevision) {
        commandRef.current = null;
        patch({ command: null, notice: null });
      } else {
        setCommandUi(
          command,
          "Your choice was recorded, but we couldn't load the latest story state yet.",
        );
      }
    },
    [isCurrent, patch, refresh, setCommandUi],
  );

  const rejectCommand = useCallback(
    async (scope: Scope, message: string) => {
      commandRef.current = null;
      syncRequiredRef.current = true;
      patch({ command: null, syncRequired: true, notice: message });
      await syncAuthoritativeState(scope);
    },
    [patch, syncAuthoritativeState],
  );

  const failCommand = useCallback(
    async (scope: Scope, command: PendingCommand, error: unknown) => {
      if (error instanceof ApiError) {
        if (error.code === 'SESSION_NOT_FOUND') return markUnavailable(scope);
        if (error.status === 401) return markAuthRequired(scope);
        if (error.code === 'IDEMPOTENCY_KEY_REUSED') {
          command.phase = 'inconsistent';
          setCommandUi(
            command,
            'This action could not be matched with your earlier one. Reload the story to continue from the saved state.',
          );
          return;
        }
        if (isRejection(error)) {
          return rejectCommand(
            scope,
            REJECTION_MESSAGES[error.code ?? ''] ?? 'That choice could not be applied.',
          );
        }
      }
      command.phase = 'retryable';
      setCommandUi(command, describeRetryable(error));
    },
    [markAuthRequired, markUnavailable, rejectCommand, setCommandUi],
  );

  /** Sends (or resends) the pending command exactly as created. */
  const sendPending = useCallback(
    async (scope: Scope) => {
      const command = commandRef.current;
      if (!command) return;
      busyRef.current = true;
      command.attempts += 1;
      const isResend = command.attempts > 1;
      command.phase = 'submitting';
      setCommandUi(command);
      try {
        const response = await withDeadline((signal) =>
          interactiveApi.submitChoice(scope.sessionId, command.request, signal),
        );
        if (!isCurrent(scope)) return;
        if (response.sessionId !== scope.sessionId) {
          command.phase = 'inconsistent';
          setCommandUi(command, 'The server answered for a different story. Reload to continue.');
        } else if (isResend) {
          // An exact retry may return the original saved response even though
          // later choices advanced the session: it only proves the command was
          // recorded and is never displayed as current state.
          await confirmRecorded(scope, command, response.revision);
        } else {
          applyView(scope, response);
          commandRef.current = null;
          patch({ command: null, notice: null });
        }
      } catch (error) {
        if (!isCurrent(scope)) return;
        await failCommand(scope, command, error);
      } finally {
        if (isCurrent(scope)) busyRef.current = false;
      }
    },
    [applyView, confirmRecorded, failCommand, isCurrent, patch, setCommandUi, withDeadline],
  );

  const submitChoice = useCallback(
    (choiceId: string) => {
      const scope = scopeRef.current;
      const view = viewRef.current;
      if (!scope || !view || view.status !== 'in_progress') return;
      if (busyRef.current || commandRef.current || syncRequiredRef.current) return;
      if (!view.choices.some((choice) => choice.id === choiceId)) return;
      busyRef.current = true; // claimed synchronously, before any await
      commandRef.current = {
        request: Object.freeze({
          choiceId,
          expectedRevision: view.revision,
          idempotencyKey: crypto.randomUUID(),
        }),
        attempts: 0,
        phase: 'submitting',
        recordedRevision: null,
      };
      patch({ notice: null });
      void sendPending(scope);
    },
    [patch, sendPending],
  );

  /** The one explicit recovery action: resend the same command, or finish confirming it. */
  const retryCommand = useCallback(() => {
    const scope = scopeRef.current;
    const command = commandRef.current;
    if (!scope || !command || busyRef.current) return;
    if (command.phase === 'retryable') {
      busyRef.current = true;
      void sendPending(scope);
    } else if (command.phase === 'confirming') {
      busyRef.current = true;
      void confirmRecorded(scope, command, command.recordedRevision ?? 0).finally(() => {
        if (isCurrent(scope)) busyRef.current = false;
      });
    }
  }, [confirmRecorded, isCurrent, sendPending]);

  const retrySync = useCallback(() => {
    const scope = scopeRef.current;
    if (!scope || busyRef.current) return;
    busyRef.current = true;
    void syncAuthoritativeState(scope).finally(() => {
      if (isCurrent(scope)) busyRef.current = false;
    });
  }, [isCurrent, syncAuthoritativeState]);

  const loadSession = useCallback(
    async (scope: Scope) => {
      patch({ phase: 'loading', loadError: null });
      const outcome = await refresh(scope, true);
      if (!isCurrent(scope) || outcome === 'dropped') return;
      if (outcome !== 'ok') {
        patch({
          phase: 'load-error',
          loadError: "We couldn't load this story. Check your connection and try again.",
        });
      }
    },
    [isCurrent, patch, refresh],
  );

  const retryLoad = useCallback(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    void loadSession(scope);
  }, [loadSession]);

  // Bind to the session, user and auth session. Every dependency change (route
  // change, account change, logout/login) starts a fresh scope and orphans
  // anything still in flight for the old one.
  useEffect(() => {
    if (authStatus !== 'authed') {
      resetRefs();
      setState(INITIAL_STATE);
      return;
    }
    const scope: Scope = { sessionId, authEpoch: getSessionEpoch() };
    resetRefs();
    scopeRef.current = scope;
    setState(INITIAL_STATE);
    void loadSession(scope);
    return () => {
      if (scopeRef.current === scope) scopeRef.current = null;
      resetRefs();
    };
  }, [sessionId, userId, authStatus, loadSession, resetRefs]);

  // Re-check the server when the tab regains attention. No polling.
  useEffect(() => {
    if (authStatus !== 'authed') return;
    const onReturn = () => {
      if (document.visibilityState === 'hidden') return;
      const scope = scopeRef.current;
      if (!scope || !viewRef.current || busyRef.current) return;
      void refresh(scope, false);
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [authStatus, sessionId, userId, refresh]);

  const choicesEnabled =
    state.phase === 'ready' &&
    state.view?.status === 'in_progress' &&
    state.command === null &&
    !state.syncRequired;

  return { ...state, choicesEnabled, submitChoice, retryCommand, retrySync, retryLoad };
}
