'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { InteractiveScenarioCatalogueEntryDto } from '@book/types';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { getSessionEpoch } from '@/lib/auth/token-store';

/** Local deadline; cancelling stops waiting, it does not cancel server work. */
export const CATALOGUE_DEADLINE_MS = 15_000;

export type CatalogueErrorKind = 'rate-limited' | 'failed';

interface CatalogueData {
  phase: 'loading' | 'ready' | 'error';
  scenarios: InteractiveScenarioCatalogueEntryDto[];
  error: CatalogueErrorKind | null;
}

const INITIAL: CatalogueData = { phase: 'loading', scenarios: [], error: null };

/**
 * The published stories a user can start. Read-only server data, fetched once
 * per account/auth session and again only on a manual `retry`. Results for
 * another account, an earlier auth session or an unmounted page are dropped.
 * A failure only affects this list: the session library is independent.
 */
export function useScenarioCatalogue() {
  const { status, user } = useAuth();
  const userId = status === 'authed' ? (user?.id ?? null) : null;
  const [store, setStore] = useState<{ ownerId: string | null; data: CatalogueData }>({
    ownerId: null,
    data: INITIAL,
  });
  const data = store.ownerId !== null && store.ownerId === userId ? store.data : INITIAL;
  const attemptRef = useRef<{ controller: AbortController; epoch: number } | null>(null);

  const load = useCallback((ownerId: string) => {
    attemptRef.current?.controller.abort();
    const attempt = { controller: new AbortController(), epoch: getSessionEpoch() };
    attemptRef.current = attempt;
    const timer = setTimeout(() => attempt.controller.abort(), CATALOGUE_DEADLINE_MS);
    const isCurrent = () => attemptRef.current === attempt && getSessionEpoch() === attempt.epoch;
    setStore({ ownerId, data: INITIAL });

    interactiveApi
      .listScenarios(attempt.controller.signal)
      .then((catalogue) => {
        if (!isCurrent()) return;
        setStore({
          ownerId,
          data: { phase: 'ready', scenarios: catalogue.scenarios, error: null },
        });
      })
      .catch((cause: unknown) => {
        if (!isCurrent()) return;
        const error: CatalogueErrorKind =
          cause instanceof ApiError && cause.status === 429 ? 'rate-limited' : 'failed';
        setStore({ ownerId, data: { phase: 'error', scenarios: [], error } });
      })
      .finally(() => clearTimeout(timer));
  }, []);

  useEffect(() => {
    if (!userId) {
      setStore({ ownerId: null, data: INITIAL });
      return;
    }
    load(userId);
    return () => {
      attemptRef.current?.controller.abort();
      attemptRef.current = null;
    };
  }, [userId, load]);

  const retry = useCallback(() => {
    if (userId) load(userId);
  }, [userId, load]);

  return { ...data, retry };
}
