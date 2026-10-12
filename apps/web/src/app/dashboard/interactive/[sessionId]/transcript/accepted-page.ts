import type { InteractiveTranscriptDto } from '@book/types';

/**
 * An accepted text page, frozen: the exact request it was fetched with and the
 * validated identity, steps and cursor it carried. Its artwork is requested with
 * these same parameters and must agree with every field below before it is used.
 */
export interface AcceptedTranscriptPage {
  /** Unique within one transcript scope: pages are told apart by the cursor that fetched them. */
  readonly id: string;
  readonly request: { readonly limit: number; readonly cursor: string | null };
  readonly sessionId: string;
  readonly scenarioId: string;
  readonly scenarioVersion: number;
  readonly completedRevision: number;
  readonly revisions: readonly number[];
  readonly sceneIds: readonly string[];
  readonly nextCursor: string | null;
}

export function describeAcceptedPage(
  page: InteractiveTranscriptDto,
  request: { limit: number; cursor: string | null },
): AcceptedTranscriptPage {
  return Object.freeze({
    id: request.cursor === null ? 'first' : `cursor:${request.cursor}`,
    request: Object.freeze({ limit: request.limit, cursor: request.cursor }),
    sessionId: page.sessionId,
    scenarioId: page.scenarioId,
    scenarioVersion: page.scenarioVersion,
    completedRevision: page.completedRevision,
    revisions: Object.freeze(page.steps.map((step) => step.revision)),
    sceneIds: Object.freeze(page.steps.map((step) => step.scene.id)),
    nextCursor: page.nextCursor,
  });
}
