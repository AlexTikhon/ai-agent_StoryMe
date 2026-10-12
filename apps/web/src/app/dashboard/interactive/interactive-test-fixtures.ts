import type {
  InteractivePresentationPanelDto,
  InteractiveScenarioCatalogueDto,
  InteractiveScenarioCatalogueEntryDto,
  InteractiveSessionListDto,
  InteractiveSessionMetadataDto,
  InteractiveSessionSummaryDto,
  InteractiveSessionViewDto,
  InteractiveTranscriptDto,
  InteractiveTranscriptPresentationDto,
  InteractiveTranscriptStepDto,
} from '@book/types';

export const SESSION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

export function makeView(
  revision: number,
  overrides: Partial<InteractiveSessionViewDto> = {},
): InteractiveSessionViewDto {
  return {
    sessionId: SESSION_ID,
    revision,
    scenarioId: 'warsaw-last-delivery',
    scenarioVersion: 1,
    scene: { id: `scene-${revision}`, title: `Scene ${revision}` },
    narration: `Narration for revision ${revision}.`,
    choices: [{ id: 'c-a', label: 'Choice A' }],
    player: { knowledge: [], inventory: [] },
    status: 'in_progress',
    ending: null,
    ...overrides,
  };
}

/** Deterministic summary `n`: ids and dates descend with n, as the API returns them. */
export function makeSummary(
  n: number,
  overrides: Partial<InteractiveSessionSummaryDto> = {},
): InteractiveSessionSummaryDto {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    sessionId: id,
    scenarioId: 'warsaw-last-delivery',
    scenarioVersion: 1,
    scenarioTitle: 'The Last Delivery',
    sceneTitle: `Scene of story ${n}`,
    status: 'in_progress',
    endingTitle: null,
    createdAt: `2026-10-0${Math.min(n, 9)}T10:00:00.000Z`,
    updatedAt: `2026-10-0${Math.min(n, 9)}T11:00:00.000Z`,
    ...overrides,
  };
}

export function makeCatalogueEntry(
  overrides: Partial<InteractiveScenarioCatalogueEntryDto> = {},
): InteractiveScenarioCatalogueEntryDto {
  return {
    scenarioId: 'warsaw-last-delivery',
    scenarioVersion: 1,
    title: 'The Last Delivery',
    language: 'en',
    synopsis: 'Warsaw, a wet evening. A courier with one parcel left.',
    ...overrides,
  };
}

export function makeCatalogue(
  ...entries: InteractiveScenarioCatalogueEntryDto[]
): InteractiveScenarioCatalogueDto {
  return { scenarios: entries.length > 0 ? entries : [makeCatalogueEntry()] };
}

export function makePage(
  summaries: InteractiveSessionSummaryDto[],
  nextCursor: string | null = null,
): InteractiveSessionListDto {
  return { sessions: summaries, nextCursor };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function makeMetadata(
  overrides: Partial<InteractiveSessionMetadataDto> = {},
): InteractiveSessionMetadataDto {
  return {
    sessionId: SESSION_ID,
    scenarioId: 'warsaw-last-delivery',
    scenarioVersion: 1,
    title: 'The Last Delivery',
    ...overrides,
  };
}

export function makeTranscriptStep(
  revision: number,
  completedRevision: number,
  overrides: Partial<InteractiveTranscriptStepDto> = {},
): InteractiveTranscriptStepDto {
  const terminal = revision === completedRevision;
  return {
    revision,
    scene: { id: `scene-${revision}`, title: `Scene ${revision}` },
    narration: `Narration for revision ${revision}.`,
    arrivedByChoiceLabel: revision === 0 ? null : `Choice into ${revision}`,
    ending: terminal ? { title: 'A Quiet Delivery', summary: 'The parcel is delivered.' } : null,
    ...overrides,
  };
}

/**
 * One transcript page holding revisions `from`..`to` of a story completed at
 * `completedRevision`. By default the next cursor follows the page, or is null on the last.
 */
export function makeTranscriptPage(
  from: number,
  to: number,
  completedRevision: number,
  overrides: Partial<InteractiveTranscriptDto> = {},
): InteractiveTranscriptDto {
  const steps: InteractiveTranscriptStepDto[] = [];
  for (let revision = from; revision <= to; revision += 1) {
    steps.push(makeTranscriptStep(revision, completedRevision));
  }
  return {
    sessionId: SESSION_ID,
    scenarioId: 'warsaw-last-delivery',
    scenarioVersion: 1,
    completedRevision,
    steps,
    nextCursor: to < completedRevision ? `cursor-${to + 1}` : null,
    ...overrides,
  };
}

/** A valid panel for scene `sceneId` of the published warsaw-noir pack. */
export function makeArtworkPanel(
  sceneId: string,
  overrides: Partial<InteractivePresentationPanelDto> = {},
): InteractivePresentationPanelDto {
  return {
    id: `p-${sceneId}`,
    src: `/interactive/warsaw-noir/v1/${sceneId}.svg`,
    width: 1200,
    height: 800,
    alt: `Artwork of ${sceneId}`,
    ...overrides,
  };
}

/**
 * The artwork page that answers `text`: same identity, revisions, scene ids and
 * cursor. With `pack: false` every step has no artwork configured.
 */
export function makeArtworkPage(
  text: InteractiveTranscriptDto,
  options: { pack?: boolean; overrides?: Partial<InteractiveTranscriptPresentationDto> } = {},
): InteractiveTranscriptPresentationDto {
  const pack = options.pack ?? true;
  return {
    sessionId: text.sessionId,
    scenarioId: text.scenarioId,
    scenarioVersion: text.scenarioVersion,
    completedRevision: text.completedRevision,
    steps: text.steps.map((step) => ({
      revision: step.revision,
      sceneId: step.scene.id,
      presentation: pack
        ? { packId: 'warsaw-noir', packVersion: 1, panels: [makeArtworkPanel(step.scene.id)] }
        : null,
    })),
    nextCursor: text.nextCursor,
    ...options.overrides,
  };
}
