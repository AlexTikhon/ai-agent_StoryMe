import type {
  CreateInteractiveSessionInput,
  InteractivePresentationDto,
  InteractiveScenarioCatalogueDto,
  InteractiveSessionMetadataDto,
  InteractiveSessionListDto,
  InteractiveSessionViewDto,
  SubmitInteractiveChoiceInput,
} from '@book/types';
import { apiFetch } from './client';

export const interactiveApi = {
  /** The published scenarios a new story can be started from (server-owned titles and versions). */
  listScenarios: (signal?: AbortSignal): Promise<InteractiveScenarioCatalogueDto> =>
    apiFetch('/interactive/scenarios', { signal }),

  /**
   * Idempotent on `command.idempotencyKey`: resending the identical command
   * (scenario id and version included) returns the original session, so an
   * ambiguous result may be retried with the same command (never with a new key). The response is the session's
   * *creation* view, not necessarily its current state.
   */
  createSession: (
    command: CreateInteractiveSessionInput,
    signal?: AbortSignal,
  ): Promise<InteractiveSessionViewDto> =>
    apiFetch('/interactive/sessions', {
      method: 'POST',
      body: JSON.stringify(command),
      signal,
    }),

  /** The caller's sessions, newest first. `cursor` is the opaque `nextCursor` of the previous page. */
  listSessions: (
    params: { limit?: number; cursor?: string | null } = {},
    signal?: AbortSignal,
  ): Promise<InteractiveSessionListDto> => {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.cursor) query.set('cursor', params.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return apiFetch(`/interactive/sessions${suffix}`, { signal });
  },

  getSession: (sessionId: string, signal?: AbortSignal): Promise<InteractiveSessionViewDto> =>
    apiFetch(`/interactive/sessions/${encodeURIComponent(sessionId)}`, { signal }),

  /**
   * Display metadata (title) of the session's pinned scenario version. Read-only and
   * separate from the session view, which is never enriched with it.
   */
  getSessionMetadata: (
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<InteractiveSessionMetadataDto> =>
    apiFetch(`/interactive/sessions/${encodeURIComponent(sessionId)}/metadata`, { signal }),

  /**
   * Artwork metadata for the scene at `expectedRevision`. Read-only; a different
   * current revision is answered with REVISION_CONFLICT. Never changes story state.
   */
  getPresentation: (
    sessionId: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<InteractivePresentationDto> =>
    apiFetch(
      `/interactive/sessions/${encodeURIComponent(sessionId)}/presentation?expectedRevision=${encodeURIComponent(String(expectedRevision))}`,
      { signal },
    ),

  /** Safe to resend with the identical command: the server deduplicates on `idempotencyKey`. */
  submitChoice: (
    sessionId: string,
    command: SubmitInteractiveChoiceInput,
    signal?: AbortSignal,
  ): Promise<InteractiveSessionViewDto> =>
    apiFetch(`/interactive/sessions/${encodeURIComponent(sessionId)}/choices`, {
      method: 'POST',
      body: JSON.stringify(command),
      signal,
    }),
};
