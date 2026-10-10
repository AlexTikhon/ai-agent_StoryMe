import type { InteractiveTranscriptDto, InteractiveTranscriptStepDto } from '@book/types';

/** What the first accepted page fixed for the whole history; every later page must repeat it. */
export interface TranscriptIdentity {
  scenarioId: string;
  scenarioVersion: number;
  completedRevision: number;
}

export interface TranscriptPageExpectation {
  sessionId: string;
  /** The page size that was requested; a longer page is a protocol violation. */
  limit: number;
  /** Revision the first step of this page must have (0 for the first page). */
  nextRevision: number;
  /** `null` until the first page has been accepted. */
  identity: TranscriptIdentity | null;
  /** The cursor this page was requested with (`null` for the first page). */
  requestedCursor: string | null;
  /** Every cursor already used, so a repeated cursor can never loop. */
  usedCursors: ReadonlySet<string>;
}

export type TranscriptPageCheck =
  { ok: true; page: InteractiveTranscriptDto } | { ok: false; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function readStep(raw: unknown): InteractiveTranscriptStepDto | null {
  if (!isRecord(raw) || !isRevision(raw['revision'])) return null;
  const scene = raw['scene'];
  if (!isRecord(scene) || !isText(scene['id']) || !isText(scene['title'])) return null;
  if (!isText(raw['narration'])) return null;
  const label = raw['arrivedByChoiceLabel'];
  if (label !== null && !isText(label)) return null;
  const ending = raw['ending'];
  if (ending !== null) {
    if (!isRecord(ending) || !isText(ending['title']) || !isText(ending['summary'])) return null;
  }
  return raw as unknown as InteractiveTranscriptStepDto;
}

/**
 * Checks one transcript response before any of it is shown: it must be for this
 * session, repeat the identity the first page fixed, continue exactly where the
 * loaded history ends, and end (or not end) consistently with its cursor.
 * Nothing is trusted from a response that fails any of this.
 */
export function checkTranscriptPage(
  raw: unknown,
  expected: TranscriptPageExpectation,
): TranscriptPageCheck {
  const fail = (reason: string): TranscriptPageCheck => ({ ok: false, reason });
  if (!isRecord(raw)) return fail('not an object');

  if (raw['sessionId'] !== expected.sessionId) return fail('page is for another session');
  const { scenarioId, scenarioVersion, completedRevision } = raw;
  if (!isText(scenarioId) || scenarioId === '') return fail('missing scenario id');
  if (!isRevision(scenarioVersion)) return fail('invalid scenario version');
  if (!isRevision(completedRevision)) return fail('invalid completed revision');
  const known = expected.identity;
  if (known) {
    if (scenarioId !== known.scenarioId) return fail('scenario changed between pages');
    if (scenarioVersion !== known.scenarioVersion) return fail('scenario version changed');
    if (completedRevision !== known.completedRevision) return fail('completed revision changed');
  }

  const rawSteps = raw['steps'];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return fail('page has no steps');
  if (rawSteps.length > expected.limit) return fail('page is longer than requested');
  const steps: InteractiveTranscriptStepDto[] = [];
  for (const rawStep of rawSteps) {
    const step = readStep(rawStep);
    if (!step) return fail('malformed step');
    steps.push(step);
  }

  for (const [index, step] of steps.entries()) {
    if (step.revision !== expected.nextRevision + index) {
      return fail(`expected revision ${expected.nextRevision + index}, got ${step.revision}`);
    }
    if (step.revision > completedRevision) return fail('step is past the completed revision');
    if ((step.revision === 0) !== (step.arrivedByChoiceLabel === null)) {
      return fail(`step ${step.revision} has an inconsistent arrival label`);
    }
    if ((step.revision === completedRevision) !== (step.ending !== null)) {
      return fail(`step ${step.revision} has an inconsistent ending`);
    }
  }

  const last = steps[steps.length - 1]!;
  const nextCursor = raw['nextCursor'];
  if (last.revision === completedRevision) {
    if (nextCursor !== null) return fail('history is complete but a next page is offered');
  } else {
    if (!isText(nextCursor) || nextCursor === '')
      return fail('history is incomplete without a next page');
    if (nextCursor === expected.requestedCursor || expected.usedCursors.has(nextCursor)) {
      return fail('next page repeats an earlier cursor');
    }
  }

  return {
    ok: true,
    page: {
      sessionId: expected.sessionId,
      scenarioId,
      scenarioVersion,
      completedRevision,
      steps,
      nextCursor,
    },
  };
}
