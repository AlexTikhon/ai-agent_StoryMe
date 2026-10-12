'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { InteractivePresentationPanelDto, InteractiveSessionViewDto } from '@book/types';
import { ApiError } from '@/lib/api/client';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { getSessionEpoch } from '@/lib/auth/token-store';
import { isPanel } from '../presentation-panels';

/** Local deadline for the artwork metadata request. */
export const PRESENTATION_DEADLINE_MS = 10_000;
/** Manual "reload" attempts allowed per scene; there are never automatic ones. */
export const MAX_ILLUSTRATION_RETRIES = 2;

export type PresentationStatus =
  | 'idle' //     no authoritative view to illustrate yet
  | 'loading' //  metadata for exactly this scene is in flight (or not yet started)
  | 'ready' //    panels for exactly this scene are available
  | 'none' //     nothing to show: no pack, conflict, or an unusable answer; the text reader is complete
  | 'error'; //   transport/service failure; a bounded manual retry may be offered

type Outcome =
  | { status: 'ready'; panels: InteractivePresentationPanelDto[] }
  | { status: 'none' }
  | { status: 'error' };

interface Settled {
  /** The exact scope the answer was requested for. */
  key: string;
  outcome: Outcome;
}

export interface ScenePresentation {
  status: PresentationStatus;
  panels: InteractivePresentationPanelDto[];
  /** Identifies the scene+auth scope the result belongs to; use as a React `key`. */
  scopeKey: string;
  canRetry: boolean;
  retry: () => void;
}

/**
 * Illustration metadata for the scene the reader currently displays.
 *
 * Deliberately independent of choice submission and story-state recovery: it
 * only reads, never blocks a choice, never changes the story and never retries
 * on its own. Every answer is bound to the session, displayed revision, scene,
 * scenario version, auth epoch and user it was requested for, and an answer is
 * used only while that scope is still the displayed one — so artwork from a
 * previous scene can never sit under new-scene text, even for a single render.
 */
export function useScenePresentation(view: InteractiveSessionViewDto | null): ScenePresentation {
  const { status: authStatus, user } = useAuth();
  const userId = user?.id ?? null;
  const epoch = getSessionEpoch();

  const sessionId = view?.sessionId ?? null;
  const revision = view?.revision ?? null;
  const sceneId = view?.scene.id ?? null;
  const scenarioId = view?.scenarioId ?? null;
  const scenarioVersion = view?.scenarioVersion ?? null;
  const active = authStatus === 'authed' && sessionId !== null;

  const baseKey = `${sessionId}|${revision}|${sceneId}|${scenarioId}@${scenarioVersion}|u${userId}|e${epoch}`;
  const [retries, setRetries] = useState<{ baseKey: string; count: number }>({
    baseKey,
    count: 0,
  });
  const retryCount = retries.baseKey === baseKey ? retries.count : 0;
  const key = `${baseKey}|r${retryCount}`;

  const [settled, setSettled] = useState<Settled | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    if (!active || sessionId === null || revision === null) return;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PRESENTATION_DEADLINE_MS);
    const stillCurrent = () =>
      generationRef.current === generation &&
      !controller.signal.aborted &&
      getSessionEpoch() === epoch;
    const settle = (outcome: Outcome) => {
      if (generationRef.current !== generation || getSessionEpoch() !== epoch) return;
      setSettled({ key, outcome });
    };

    // A synchronous throw (e.g. an unavailable API) is an outage like any other.
    Promise.resolve()
      .then(() => interactiveApi.getPresentation(sessionId, revision, controller.signal))
      .then((dto) => {
        if (!stillCurrent()) return;
        const matches =
          dto.sessionId === sessionId &&
          dto.revision === revision &&
          dto.sceneId === sceneId &&
          dto.scenarioId === scenarioId &&
          dto.scenarioVersion === scenarioVersion;
        const panels = dto.presentation?.panels;
        if (!matches || !Array.isArray(panels) || panels.length === 0 || !panels.every(isPanel)) {
          settle({ status: 'none' });
        } else {
          settle({ status: 'ready', panels });
        }
      })
      .catch((error: unknown) => {
        if (generationRef.current !== generation || getSessionEpoch() !== epoch) return;
        if (
          error instanceof ApiError &&
          (error.code === 'REVISION_CONFLICT' ||
            error.code === 'SESSION_NOT_FOUND' ||
            error.status === 401)
        ) {
          // The reader's own recovery owns these; the picture just stays out of the way.
          settle({ status: 'none' });
        } else {
          settle({ status: 'error' });
        }
      })
      .finally(() => clearTimeout(timer));

    return () => {
      // Invalidate first so a result racing the cleanup is always dropped.
      generationRef.current += 1;
      clearTimeout(timer);
      controller.abort();
    };
    // `key` already encodes every scope input; the individual values are what the request uses.
  }, [active, sessionId, revision, sceneId, scenarioId, scenarioVersion, epoch, key]);

  const retry = useCallback(() => {
    setRetries((current) => {
      const count = current.baseKey === baseKey ? current.count : 0;
      return count >= MAX_ILLUSTRATION_RETRIES ? current : { baseKey, count: count + 1 };
    });
  }, [baseKey]);

  if (!active) {
    return { status: 'idle', panels: [], scopeKey: key, canRetry: false, retry };
  }
  const outcome = settled?.key === key ? settled.outcome : null;
  return {
    status: outcome ? outcome.status : 'loading',
    panels: outcome?.status === 'ready' ? outcome.panels : [],
    scopeKey: key,
    canRetry: outcome?.status === 'error' && retryCount < MAX_ILLUSTRATION_RETRIES,
    retry,
  };
}
