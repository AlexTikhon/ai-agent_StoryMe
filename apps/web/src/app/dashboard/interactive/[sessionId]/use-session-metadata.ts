'use client';

import { useEffect, useRef, useState } from 'react';
import type { InteractiveSessionMetadataDto, InteractiveSessionViewDto } from '@book/types';
import { interactiveApi } from '@/lib/api/interactive';
import { useAuth } from '@/lib/auth/auth-context';
import { getSessionEpoch } from '@/lib/auth/token-store';

/** Local deadline for the metadata request. */
export const SESSION_METADATA_DEADLINE_MS = 10_000;
/** Shown whenever the server title is unavailable, failed, late or does not match. */
export const DEFAULT_READER_TITLE = 'Interactive story';

const MAX_TITLE_LENGTH = 80;

/** The identity fields the title request is scoped by; a full session view satisfies it. */
export type SessionMetadataIdentity = Pick<
  InteractiveSessionViewDto,
  'sessionId' | 'scenarioId' | 'scenarioVersion'
>;

export interface SessionMetadataState {
  /** Plain text: render it escaped, never as markup. */
  title: string;
}

interface Settled {
  /** The exact scope the title was requested for. */
  key: string;
  title: string;
}

function usableTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.trim() === '' || value.length > MAX_TITLE_LENGTH || /[\r\n]/.test(value)) return null;
  return value;
}

/**
 * Display title of the scenario version the reader's session is pinned to.
 *
 * Purely cosmetic and fully independent of the story: it never blocks or
 * delays narration, choices, retries, reload/resume or illustrations, and
 * every failure degrades to a generic title. One request per
 * session + pinned scenario identity + user + auth epoch: scene and revision
 * changes are deliberately not part of the scope, there is no polling and no
 * automatic retry. An answer is used only while the scope it was requested
 * for is still the displayed one, and it must describe exactly that session,
 * scenario id and version — so a title can never be adopted from another
 * session, a newer version or a previous account.
 */
export function useSessionMetadata(identity: SessionMetadataIdentity | null): SessionMetadataState {
  const { status: authStatus, user } = useAuth();
  const userId = user?.id ?? null;
  const epoch = getSessionEpoch();

  const sessionId = identity?.sessionId ?? null;
  const scenarioId = identity?.scenarioId ?? null;
  const scenarioVersion = identity?.scenarioVersion ?? null;
  const active = authStatus === 'authed' && sessionId !== null;
  const key = `${sessionId}|${scenarioId}@${scenarioVersion}|u${userId}|e${epoch}`;

  const [settled, setSettled] = useState<Settled | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    if (!active || sessionId === null || scenarioId === null || scenarioVersion === null) return;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SESSION_METADATA_DEADLINE_MS);
    const stillCurrent = () =>
      generationRef.current === generation &&
      !controller.signal.aborted &&
      getSessionEpoch() === epoch;

    // A synchronous throw (e.g. an unavailable API) is an outage like any other.
    Promise.resolve()
      .then(() => interactiveApi.getSessionMetadata(sessionId, controller.signal))
      .then((dto: InteractiveSessionMetadataDto) => {
        if (!stillCurrent()) return;
        const title = usableTitle(dto?.title);
        const matches =
          dto?.sessionId === sessionId &&
          dto.scenarioId === scenarioId &&
          dto.scenarioVersion === scenarioVersion;
        if (matches && title !== null) setSettled({ key, title });
      })
      .catch(() => {
        // Any failure keeps the generic title; nothing else depends on this request.
      })
      .finally(() => clearTimeout(timer));

    return () => {
      // Invalidate first so a result racing the cleanup is always dropped.
      generationRef.current += 1;
      clearTimeout(timer);
      controller.abort();
    };
    // `key` already encodes every scope input; the individual values are what the request uses.
  }, [active, sessionId, scenarioId, scenarioVersion, epoch, key]);

  return { title: active && settled?.key === key ? settled.title : DEFAULT_READER_TITLE };
}
