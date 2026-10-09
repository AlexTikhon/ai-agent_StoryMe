/**
 * Every bound of the scenario-authoring workflow in one place. These are local
 * guards: none of them relies on a prompt instruction being obeyed.
 */

export const PROMPT_VERSION = 'interactive-authoring-prompt/v1';
export const WIRE_SCHEMA_VERSION = 'interactive-authoring-wire/v1';

// ── Authoring format (first, deliberately narrow) ───────────────────────────
export const MIN_SCENES = 6;
export const MAX_SCENES = 8;
export const REQUIRED_DECISION_POINTS = 3;
export const REQUIRED_ENDINGS = 2;
export const REQUIRED_CHARACTERS = 3;
export const MAX_FACTS = 16;
export const MAX_ITEMS = 6;
export const MAX_FLAGS = 12;
export const MAX_CHOICES_PER_SCENE = 3;

// ── Input / output sizes ────────────────────────────────────────────────────
export const MAX_BRIEF_BYTES = 8_000;
/** Raw candidate text the pipeline will even attempt to parse. */
export const MAX_CANDIDATE_CHARS = 60_000;
/** Canonical size of a normalized, accepted candidate. */
export const MAX_NORMALIZED_CANDIDATE_BYTES = 48_000;
/** Raw HTTP body the OpenAI adapter will read. */
export const MAX_HTTP_BODY_CHARS = 200_000;

// ── Diagnostics ─────────────────────────────────────────────────────────────
export const MAX_DIAGNOSTICS = 25;
export const MAX_DIAGNOSTIC_MESSAGE_CHARS = 240;

// ── Call budget and time ────────────────────────────────────────────────────
/** One generation request plus at most one repair request. */
export const MAX_REQUESTS = 2;
/** Total provider HTTP attempts across the whole run, retries included. */
export const MAX_HTTP_ATTEMPTS = 2;

export const DEFAULT_MAX_OUTPUT_TOKENS = 8_000;
export const MIN_MAX_OUTPUT_TOKENS = 1_000;
export const HARD_MAX_OUTPUT_TOKENS = 16_000;

export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const MIN_REQUEST_TIMEOUT_MS = 5_000;
export const HARD_MAX_REQUEST_TIMEOUT_MS = 300_000;

export const DEFAULT_DEADLINE_MS = 300_000;
export const MIN_DEADLINE_MS = 5_000;
export const HARD_MAX_DEADLINE_MS = 600_000;
