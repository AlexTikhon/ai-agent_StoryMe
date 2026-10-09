/**
 * Public HTTP contract of the interactive story endpoints
 * (`/api/interactive/sessions`). Types only: runtime validation lives in the
 * API, and server state, events and scenario definitions are deliberately not
 * shared with clients.
 */

/** POST /api/interactive/sessions body. */
export interface CreateInteractiveSessionInput {
  scenarioId: string;
  /**
   * Client-generated key identifying one deliberate "start story" action.
   * Resending the identical command with it returns the original session.
   */
  idempotencyKey: string;
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

/** One entry of the session library: an allow-listed summary, never state or history. */
export interface InteractiveSessionSummaryDto {
  sessionId: string;
  scenarioId: string;
  scenarioVersion: number;
  /** Title of the scene the session is currently at. */
  sceneTitle: string;
  status: 'in_progress' | 'ended';
  /** Title of the reached ending, once `status` is `ended`. */
  endingTitle: string | null;
  /** ISO-8601 timestamps. */
  createdAt: string;
  updatedAt: string;
}

/** GET /api/interactive/sessions?limit=&cursor= response, newest session first. */
export interface InteractiveSessionListDto {
  sessions: InteractiveSessionSummaryDto[];
  /** Opaque; pass back as `cursor` for the next page. `null` on the last page. */
  nextCursor: string | null;
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
  | 'SESSION_BUSY'
  | 'SESSION_LIMIT_REACHED'
  | 'RATE_LIMITED'
  | 'RATE_LIMIT_UNAVAILABLE';
