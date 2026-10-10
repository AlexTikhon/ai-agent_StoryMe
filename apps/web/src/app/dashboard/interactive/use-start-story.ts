'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  CreateInteractiveSessionInput,
  InteractiveScenarioCatalogueEntryDto,
} from '@book/types';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { getSessionEpoch } from '@/lib/auth/token-store';

const CREATE_DEADLINE_MS = 20_000;

/** What the user is told after each kind of failure. */
const MESSAGES = {
  ambiguous:
    "We couldn't confirm that your story started. Trying again is safe: it won't start a second story. If it did start, it is also listed under Your stories.",
  unavailable: 'The service is having trouble. Please try again in a moment.',
  rateLimited: "You're starting stories too quickly. Wait a moment, then try again.",
  limitReached:
    "You've reached the maximum number of stories for now. Open one of your existing stories below.",
  rejected: "The story couldn't be started. Please try again.",
} as const;

const NOT_COMMITTED_CODES: ReadonlySet<string> = new Set([
  'SESSION_BUSY',
  'RATE_LIMIT_UNAVAILABLE',
  'NARRATION_INVALID',
  'NARRATION_PROVIDER_FAILED',
]);

interface Failure {
  message: string;
  /** The same command may be resent; otherwise it is resolved and the next start is a new one. */
  retryable: boolean;
}

function classify(cause: unknown): Failure {
  if (!(cause instanceof ApiError)) return { message: MESSAGES.ambiguous, retryable: true };
  if (cause.code === 'SESSION_LIMIT_REACHED') {
    return { message: MESSAGES.limitReached, retryable: false };
  }
  // Refused before anything ran (rate limit); the identical command is still the right one.
  if (cause.status === 429) return { message: MESSAGES.rateLimited, retryable: true };
  if (cause.status >= 500) {
    // Stable codes that mean nothing was committed; an unlabelled 5xx (a proxy
    // timeout, say) may have happened after the commit.
    const notCommitted = cause.code !== undefined && NOT_COMMITTED_CODES.has(cause.code);
    return { message: notCommitted ? MESSAGES.unavailable : MESSAGES.ambiguous, retryable: true };
  }
  return { message: MESSAGES.rejected, retryable: false };
}

/** The story a creation command is for; the idempotency key stays private to the hook. */
export type StartTarget = Pick<
  InteractiveScenarioCatalogueEntryDto,
  'scenarioId' | 'scenarioVersion'
>;

/**
 * Creates a session only when `start` or `retry` is called by a user action,
 * then opens its reader URL.
 *
 * Each deliberate start captures one immutable creation command: the exact
 * scenario id and version of the clicked catalogue entry plus a fresh
 * idempotency key. While the outcome is unknown or temporarily refused, that
 * command is kept in memory, no other story can be started, and a manual
 * `retry` resends it unchanged however the catalogue has changed since, so the
 * server converges on a single session. A definitive rejection resolves the
 * command; the next start mints a new one. Nothing is retried automatically.
 * The command is not persisted across reload: a session whose response was lost
 * stays discoverable through the session library.
 */
export function useStartStory() {
  const router = useRouter();
  const { status, user } = useAuth();
  const userId = user?.id ?? null;
  const [starting, setStarting] = useState(false);
  const [active, setActive] = useState<StartTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const commandRef = useRef<Readonly<CreateInteractiveSessionInput> | null>(null);
  const attemptRef = useRef<{ controller: AbortController; epoch: number } | null>(null);

  // Orphan any pending creation when the page unmounts or the account/auth
  // session changes; its late result must not navigate anywhere, and the
  // command (an identity of the previous account) is dropped.
  useEffect(() => {
    return () => {
      attemptRef.current?.controller.abort();
      attemptRef.current = null;
      commandRef.current = null;
      inFlightRef.current = false;
      setStarting(false);
      setActive(null);
    };
  }, [userId, status]);

  const send = useCallback(() => {
    const command = commandRef.current;
    if (!command || inFlightRef.current) return;
    inFlightRef.current = true;
    const attempt = { controller: new AbortController(), epoch: getSessionEpoch() };
    attemptRef.current = attempt;
    const timer = setTimeout(() => attempt.controller.abort(), CREATE_DEADLINE_MS);
    const isCurrent = () => attemptRef.current === attempt && getSessionEpoch() === attempt.epoch;
    setStarting(true);
    setError(null);

    interactiveApi
      .createSession(command, attempt.controller.signal)
      .then((view) => {
        if (!isCurrent()) return;
        commandRef.current = null;
        // The response is the creation-time view (possibly a replay); the reader
        // fetches the current state. Stay in "starting" until navigation takes over.
        router.push(`/dashboard/interactive/${encodeURIComponent(view.sessionId)}`);
      })
      .catch((cause: unknown) => {
        if (!isCurrent()) return;
        inFlightRef.current = false;
        const failure = classify(cause);
        if (!failure.retryable) {
          commandRef.current = null;
          setActive(null);
        }
        setStarting(false);
        setError(failure.message);
      })
      .finally(() => clearTimeout(timer));
  }, [router]);

  /** Starts a new story. Ignored while any start is in flight or awaiting a manual retry. */
  const start = useCallback(
    (target: StartTarget) => {
      if (inFlightRef.current || commandRef.current) return;
      commandRef.current = Object.freeze({
        scenarioId: target.scenarioId,
        scenarioVersion: target.scenarioVersion,
        idempotencyKey: crypto.randomUUID(),
      });
      setActive({ scenarioId: target.scenarioId, scenarioVersion: target.scenarioVersion });
      send();
    },
    [send],
  );

  /** Resends the held command exactly as captured; a no-op when there is none. */
  const retry = useCallback(() => send(), [send]);

  return { start, retry, starting, error, active };
}
