'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { getSessionEpoch } from '@/lib/auth/token-store';

/** Public identifier of the one shipped scenario; the story itself lives on the server. */
export const WARSAW_SCENARIO_ID = 'warsaw-last-delivery';
const CREATE_DEADLINE_MS = 20_000;

/**
 * Creates a session only when `start` is called by a user action, then opens
 * its reader URL. Session creation has no idempotency key, so an ambiguous
 * failure (timeout, lost response) is reported, never retried automatically,
 * and the user is told another attempt may create a second story.
 */
export function useStartStory() {
  const router = useRouter();
  const { status, user } = useAuth();
  const userId = user?.id ?? null;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const attemptRef = useRef<{ controller: AbortController; epoch: number } | null>(null);

  // Orphan any pending creation when the page unmounts or the account/auth
  // session changes; its late result must not navigate anywhere.
  useEffect(() => {
    return () => {
      attemptRef.current?.controller.abort();
      attemptRef.current = null;
      inFlightRef.current = false;
    };
  }, [userId, status]);

  const start = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const attempt = { controller: new AbortController(), epoch: getSessionEpoch() };
    attemptRef.current = attempt;
    const timer = setTimeout(() => attempt.controller.abort(), CREATE_DEADLINE_MS);
    const isCurrent = () => attemptRef.current === attempt && getSessionEpoch() === attempt.epoch;
    setStarting(true);
    setError(null);

    interactiveApi
      .createSession(WARSAW_SCENARIO_ID, attempt.controller.signal)
      .then((view) => {
        if (!isCurrent()) return;
        // Stay in the "starting" state until navigation takes over.
        router.push(`/dashboard/interactive/${encodeURIComponent(view.sessionId)}`);
      })
      .catch((cause: unknown) => {
        if (!isCurrent()) return;
        inFlightRef.current = false;
        setStarting(false);
        if (cause instanceof ApiError && cause.status !== 429 && cause.status < 500) {
          setError("The story couldn't be started. Please try again.");
        } else if (cause instanceof ApiError) {
          setError('The service is having trouble. Please try again in a moment.');
        } else {
          setError(
            "We couldn't confirm that your story started. Starting again may create a second story.",
          );
        }
      })
      .finally(() => clearTimeout(timer));
  }, [router]);

  return { start, starting, error };
}
