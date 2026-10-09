/**
 * Public HTTP contract of the interactive story endpoints
 * (`/api/interactive/sessions`). Types only: runtime validation lives in the
 * API, and server state, events and scenario definitions are deliberately not
 * shared with clients.
 */

/** POST /api/interactive/sessions body. */
export interface CreateInteractiveSessionInput {
  scenarioId: string;
}

/** POST /api/interactive/sessions/:id/choices body. */
export interface SubmitInteractiveChoiceInput {
  choiceId: string;
  /** The revision the player was looking at when choosing. */
  expectedRevision: number;
  /** Client-generated key; resending the same command with it is safe. */
  idempotencyKey: string;
}

export interface InteractiveChoiceDto {
  id: string;
  label: string;
}

export interface InteractiveEndingDto {
  id: string;
  title: string;
  summary: string;
}

/**
 * Response of every interactive endpoint: the allow-listed view of one
 * session at one revision. Only currently available choices are included.
 */
export interface InteractiveSessionViewDto {
  sessionId: string;
  revision: number;
  scenarioId: string;
  scenarioVersion: number;
  scene: { id: string; title: string };
  narration: string;
  choices: InteractiveChoiceDto[];
  player: {
    knowledge: Array<{ id: string; text: string }>;
    inventory: Array<{ id: string; name: string }>;
  };
  status: 'in_progress' | 'ended';
  ending: InteractiveEndingDto | null;
}

/** Stable `code` values the interactive endpoints return on failure. */
export type InteractiveErrorCode =
  | 'INVALID_REQUEST'
  | 'SESSION_NOT_FOUND'
  | 'UNKNOWN_CHOICE'
  | 'UNKNOWN_SCENARIO'
  | 'REVISION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'CHOICE_UNAVAILABLE'
  | 'SESSION_TERMINAL'
  | 'NARRATION_INVALID'
  | 'NARRATION_PROVIDER_FAILED'
  | 'SESSION_BUSY';
