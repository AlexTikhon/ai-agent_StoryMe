import type {
  CreateInteractiveSessionInput,
  InteractivePresentationDto,
  InteractiveSessionListDto,
  InteractiveSessionViewDto,
  SubmitInteractiveChoiceInput,
} from '@book/types';
import { apiFetch } from './client';

export const interactiveApi = {
  /**
   * Idempotent on `command.idempotencyKey`: resending the identical command
   * returns the original session, so an ambiguous result may be retried with
   * the same command (never with a new key). The response is the session's
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
