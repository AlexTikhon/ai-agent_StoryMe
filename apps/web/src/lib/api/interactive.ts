import type {
  CreateInteractiveSessionInput,
  InteractiveSessionViewDto,
  SubmitInteractiveChoiceInput,
} from '@book/types';
import { apiFetch } from './client';

export const interactiveApi = {
  /**
   * Not idempotent on the server: every call that reaches it creates a
   * session, so callers must never retry it automatically.
   */
  createSession: (scenarioId: string, signal?: AbortSignal): Promise<InteractiveSessionViewDto> => {
    const body: CreateInteractiveSessionInput = { scenarioId };
    return apiFetch('/interactive/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    });
  },

  getSession: (sessionId: string, signal?: AbortSignal): Promise<InteractiveSessionViewDto> =>
    apiFetch(`/interactive/sessions/${encodeURIComponent(sessionId)}`, { signal }),

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
