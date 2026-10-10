import type {
  InteractivePresentationDto,
  InteractiveTranscriptPresentationDto,
} from '@book/types';
import { z } from 'zod';
import { getScenario } from '../scenarios';
import { WARSAW_NOIR_V1_DATA } from './packs';
import {
  PresentationPackError,
  parsePresentationPack,
  type PresentationPack,
} from './presentation-schema';

/**
 * The response is built from an explicit allow-list and validated by a strict
 * schema: only identifiers of the *current* scene, the pack identity and that
 * scene's panels. Never the manifest, other scenes, state, flags or events.
 */
const scenePresentationSchema = z
  .object({
    packId: z.string(),
    packVersion: z.number().int(),
    panels: z.array(
      z
        .object({
          id: z.string(),
          src: z.string(),
          width: z.number().int(),
          height: z.number().int(),
          alt: z.string(),
        })
        .strict(),
    ),
  })
  .strict()
  .nullable();

export const presentationResponseSchema = z
  .object({
    sessionId: z.string(),
    revision: z.number().int().min(0),
    scenarioId: z.string(),
    scenarioVersion: z.number().int(),
    sceneId: z.string(),
    presentation: scenePresentationSchema,
  })
  .strict();

/**
 * Same allow-list for the artwork transcript: per stored step only the revision,
 * scene id and that scene's presentation.
 */
export const transcriptPresentationResponseSchema = z
  .object({
    sessionId: z.string(),
    scenarioId: z.string(),
    scenarioVersion: z.number().int(),
    completedRevision: z.number().int().min(0),
    steps: z.array(
      z
        .object({
          revision: z.number().int().min(0),
          sceneId: z.string(),
          presentation: scenePresentationSchema,
        })
        .strict(),
    ),
    nextCursor: z.string().nullable(),
  })
  .strict();

type AssertMutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const presentationMatchesSharedContract: AssertMutuallyAssignable<
  z.infer<typeof presentationResponseSchema>,
  InteractivePresentationDto
> = true;
export const transcriptPresentationMatchesSharedContract: AssertMutuallyAssignable<
  z.infer<typeof transcriptPresentationResponseSchema>,
  InteractiveTranscriptPresentationDto
> = true;

/**
 * A pack must cover every scene of its scenario and name no scene that does not
 * exist; the process fails to start otherwise.
 */
export function loadPresentationPack(raw: unknown): PresentationPack {
  const pack = parsePresentationPack(raw);
  const scenario = getScenario(pack.scenarioId, pack.scenarioVersion);
  if (!scenario) {
    throw new PresentationPackError([
      `${pack.packId}@${pack.packVersion}: unknown scenario ${pack.scenarioId}@${pack.scenarioVersion}`,
    ]);
  }
  const sceneIds = new Set(scenario.scenes.map((s) => s.id));
  const issues: string[] = [];
  for (const id of sceneIds) {
    if (!(id in pack.scenes)) issues.push(`no panel for scene ${id}`);
  }
  for (const id of Object.keys(pack.scenes)) {
    if (!sceneIds.has(id)) issues.push(`panel for unknown scene ${id}`);
  }
  if (issues.length > 0) throw new PresentationPackError(issues);
  return pack;
}

/**
 * Every published pack, selected by the scenario (id, version) it illustrates.
 * Story versions are pinned to sessions; the pack is NOT: it is selected here
 * at read time, so artwork is not historically pinned in this phase.
 */
const PACKS: readonly PresentationPack[] = [loadPresentationPack(WARSAW_NOIR_V1_DATA)];

export const WARSAW_NOIR_V1: PresentationPack = PACKS[0]!;

export function listPresentationPacks(): readonly PresentationPack[] {
  return PACKS;
}

/** The newest pack published for a scenario version, or undefined if none. */
export function getPresentationPack(
  scenarioId: string,
  scenarioVersion: number,
): PresentationPack | undefined {
  return PACKS.filter(
    (p) => p.scenarioId === scenarioId && p.scenarioVersion === scenarioVersion,
  ).sort((a, b) => b.packVersion - a.packVersion)[0];
}

/** The identity fields artwork selection actually depends on. */
export interface PresentationIdentity {
  sessionId: string;
  revision: number;
  scenarioId: string;
  scenarioVersion: number;
  scene: { id: string };
}

/**
 * The artwork for one scene of a scenario version, or null when the registry has
 * no pack for that version or the pack does not name the scene.
 */
function selectScenePresentation(scenarioId: string, scenarioVersion: number, sceneId: string) {
  const pack = getPresentationPack(scenarioId, scenarioVersion);
  const panels = pack?.scenes[sceneId];
  if (!pack || !panels) return null;
  return {
    packId: pack.packId,
    packVersion: pack.packVersion,
    panels: panels.map((p) => ({
      id: p.id,
      src: p.src,
      width: p.width,
      height: p.height,
      alt: p.alt,
    })),
  };
}

/**
 * Selects the presentation for the scene of an authoritative public view.
 * Pure: reads nothing but the identity fields and the immutable pack registry.
 */
export function projectPresentation(view: PresentationIdentity): InteractivePresentationDto {
  return presentationResponseSchema.parse({
    sessionId: view.sessionId,
    revision: view.revision,
    scenarioId: view.scenarioId,
    scenarioVersion: view.scenarioVersion,
    sceneId: view.scene.id,
    presentation: selectScenePresentation(view.scenarioId, view.scenarioVersion, view.scene.id),
  });
}

/** The parts of a validated text-transcript page the artwork page is derived from. */
export interface TranscriptPresentationSource {
  sessionId: string;
  scenarioId: string;
  scenarioVersion: number;
  completedRevision: number;
  steps: ReadonlyArray<{ revision: number; scene: { id: string } }>;
  nextCursor: string | null;
}

/**
 * Artwork for the scenes a validated transcript page actually visited, selected
 * at read time from the pack registry for the session's pinned scenario
 * version. Pure: revisions, scene ids and the cursor are copied from the text
 * page, never re-derived, so the two pages cannot disagree.
 */
export function projectTranscriptPresentation(
  page: TranscriptPresentationSource,
): InteractiveTranscriptPresentationDto {
  return transcriptPresentationResponseSchema.parse({
    sessionId: page.sessionId,
    scenarioId: page.scenarioId,
    scenarioVersion: page.scenarioVersion,
    completedRevision: page.completedRevision,
    steps: page.steps.map((step) => ({
      revision: step.revision,
      sceneId: step.scene.id,
      presentation: selectScenePresentation(page.scenarioId, page.scenarioVersion, step.scene.id),
    })),
    nextCursor: page.nextCursor,
  });
}
