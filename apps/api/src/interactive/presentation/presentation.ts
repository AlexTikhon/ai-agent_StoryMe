import type { InteractivePresentationDto } from '@book/types';
import { z } from 'zod';
import type { PublicSessionView } from '../public-view';
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
export const presentationResponseSchema = z
  .object({
    sessionId: z.string(),
    revision: z.number().int().min(0),
    scenarioId: z.string(),
    scenarioVersion: z.number().int(),
    sceneId: z.string(),
    presentation: z
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
      .nullable(),
  })
  .strict();

type AssertMutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const presentationMatchesSharedContract: AssertMutuallyAssignable<
  z.infer<typeof presentationResponseSchema>,
  InteractivePresentationDto
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

/**
 * Selects the presentation for the scene of an authoritative public view.
 * Pure: reads nothing but the view and the immutable pack registry.
 */
export function projectPresentation(view: PublicSessionView): InteractivePresentationDto {
  const pack = getPresentationPack(view.scenarioId, view.scenarioVersion);
  const panels = pack?.scenes[view.scene.id];
  return presentationResponseSchema.parse({
    sessionId: view.sessionId,
    revision: view.revision,
    scenarioId: view.scenarioId,
    scenarioVersion: view.scenarioVersion,
    sceneId: view.scene.id,
    presentation:
      pack && panels
        ? {
            packId: pack.packId,
            packVersion: pack.packVersion,
            panels: panels.map((p) => ({
              id: p.id,
              src: p.src,
              width: p.width,
              height: p.height,
              alt: p.alt,
            })),
          }
        : null,
  });
}
