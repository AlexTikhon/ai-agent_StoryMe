import type { InteractiveTranscriptDto, InteractiveTranscriptStepDto } from '@book/types';
import { EVENT_SCHEMA_VERSION, choiceMadePayload, sessionStartedPayload } from './domain/engine';
import { publicSessionViewSchema, type PublicSessionView } from './public-view';
import type { TranscriptCursor } from './requests';

/**
 * Read-only transcript of a completed session, rebuilt only from the public
 * responses stored on its events. Nothing here consults the scenario registry,
 * narrator or session state: those may have changed since the steps were
 * played, and the stored responses are what the player actually saw.
 */

/** The session columns the transcript is checked against. */
export interface TranscriptSession {
  id: string;
  scenarioId: string;
  scenarioVersion: number;
  /** Revision of the session's current (for a completed session, terminal) event. */
  revision: number;
}

/** The only event columns that are read; hashes and idempotency data are never selected. */
export interface StoredEventRow {
  seq: number;
  type: string;
  schemaVersion: number;
  payload: unknown;
  response: unknown;
}

export type TranscriptPage = Omit<InteractiveTranscriptDto, 'nextCursor'> & {
  nextCursor: TranscriptCursor | null;
};

/** Stored data is missing or inconsistent; mapped to SESSION_STATE_INVALID by the service. */
export class TranscriptIntegrityError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'TranscriptIntegrityError';
  }
}

/**
 * Event range to fetch for the page starting at revision `from`: the page
 * itself plus, after the first page, its predecessor (whose stored choices
 * label the step that leads into the page).
 */
export function transcriptWindow(
  from: number,
  limit: number,
  completedRevision: number,
): { lo: number; hi: number } {
  return {
    lo: from > 0 ? from - 1 : 0,
    hi: Math.min(from + limit - 1, completedRevision),
  };
}

/** One event, checked against the session and the position it must occupy. */
function readStep(session: TranscriptSession, row: StoredEventRow, seq: number) {
  if (row.seq !== seq)
    throw new TranscriptIntegrityError(`expected event ${seq}, found ${row.seq}`);
  const expectedType = seq === 0 ? 'SessionStarted' : 'ChoiceMade';
  if (row.type !== expectedType) {
    throw new TranscriptIntegrityError(`event ${seq} is ${row.type}, expected ${expectedType}`);
  }
  if (row.schemaVersion !== EVENT_SCHEMA_VERSION) {
    throw new TranscriptIntegrityError(`event ${seq} has unsupported version ${row.schemaVersion}`);
  }

  const view = publicSessionViewSchema.safeParse(row.response);
  if (!view.success) throw new TranscriptIntegrityError(`event ${seq} has an invalid response`);
  if (
    view.data.sessionId !== session.id ||
    view.data.revision !== seq ||
    view.data.scenarioId !== session.scenarioId ||
    view.data.scenarioVersion !== session.scenarioVersion
  ) {
    throw new TranscriptIntegrityError(`event ${seq} response belongs to another identity`);
  }

  if (seq === 0) {
    const payload = sessionStartedPayload.safeParse(row.payload);
    if (
      !payload.success ||
      payload.data.scenarioId !== session.scenarioId ||
      payload.data.scenarioVersion !== session.scenarioVersion
    ) {
      throw new TranscriptIntegrityError('genesis payload is invalid');
    }
    return { view: view.data, choice: null };
  }
  const payload = choiceMadePayload.safeParse(row.payload);
  if (!payload.success) throw new TranscriptIntegrityError(`event ${seq} payload is invalid`);
  return { view: view.data, choice: payload.data };
}

/**
 * Whether the session is finished, judged from the stored response of its
 * terminal event (not from state). Anything but a coherent terminal event is
 * an integrity error rather than "in progress".
 */
export function assessCompletion(
  session: TranscriptSession,
  terminal: StoredEventRow,
): 'ended' | 'in_progress' {
  return readStep(session, terminal, session.revision).view.status;
}

function labelFor(previous: PublicSessionView, choice: { choiceId: string; fromSceneId: string }) {
  if (choice.fromSceneId !== previous.scene.id) {
    throw new TranscriptIntegrityError('choice was recorded from a different scene');
  }
  const offered = previous.choices.find((c) => c.id === choice.choiceId);
  if (!offered) throw new TranscriptIntegrityError('choice was not offered at the previous step');
  return offered.label;
}

/**
 * Builds one page. `rows` must be exactly the events of
 * `transcriptWindow(from, limit, session.revision)`, in sequence order; a
 * missing, extra, repeated or reordered row is an integrity error, never
 * silently skipped.
 */
export function buildTranscriptPage(input: {
  session: TranscriptSession;
  rows: readonly StoredEventRow[];
  from: number;
  limit: number;
}): TranscriptPage {
  const { session, rows, from, limit } = input;
  const completedRevision = session.revision;
  const { lo, hi } = transcriptWindow(from, limit, completedRevision);
  if (rows.length !== hi - lo + 1) {
    throw new TranscriptIntegrityError(`expected ${hi - lo + 1} events, found ${rows.length}`);
  }

  const steps: InteractiveTranscriptStepDto[] = [];
  let previous: PublicSessionView | null = null;
  for (const [index, row] of rows.entries()) {
    const seq = lo + index;
    const { view, choice } = readStep(session, row, seq);
    const terminal = seq === completedRevision;
    if (terminal !== (view.status === 'ended') || terminal !== (view.ending !== null)) {
      throw new TranscriptIntegrityError(`event ${seq} has an unexpected ending state`);
    }
    const before = previous;
    previous = view;
    if (seq < from) continue; // the predecessor is read only to label the first step

    let arrivedByChoiceLabel: string | null = null;
    if (choice) {
      if (!before) throw new TranscriptIntegrityError(`event ${seq} has no predecessor`);
      arrivedByChoiceLabel = labelFor(before, choice);
    }
    steps.push({
      revision: view.revision,
      scene: { id: view.scene.id, title: view.scene.title },
      narration: view.narration,
      arrivedByChoiceLabel,
      ending: view.ending ? { title: view.ending.title, summary: view.ending.summary } : null,
    });
  }

  const nextRevision = hi + 1;
  return {
    sessionId: session.id,
    scenarioId: session.scenarioId,
    scenarioVersion: session.scenarioVersion,
    completedRevision,
    steps,
    nextCursor:
      nextRevision <= completedRevision
        ? { sessionId: session.id, completedRevision, nextRevision }
        : null,
  };
}
