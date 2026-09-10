import type { CharacterVisualBible } from '@book/types';
import { buildVisualIdentityBlock } from './character-visual-bible';
import {
  NO_TEXT_IN_IMAGE_INSTRUCTION,
  PRESERVE_APPEARANCE_INSTRUCTION,
} from './story-generation-contracts';

export interface ImageSceneContext {
  kind: 'cover' | 'page' | 'back_cover';
  theme: string;
  summary: string;
  action?: string;
  location?: string;
  mood?: string;
  supportingDetails?: readonly string[];
  wardrobeChange?: string;
}

function safe(value: string | undefined): string | undefined {
  const cleaned = value?.trim().replace(/\s+/gu, ' ');
  return cleaned ? cleaned : undefined;
}

/** Focused builder separating stable identity from one page's variable scene. */
export function buildBookImagePrompt(input: {
  bible: CharacterVisualBible;
  scene: ImageSceneContext;
}): string {
  const scene = input.scene;
  const parts = [
    '[STABLE CHARACTER IDENTITY]',
    buildVisualIdentityBlock(input.bible),
    '[END STABLE CHARACTER IDENTITY]',
    '[PAGE-SPECIFIC SCENE]',
    `Asset: ${scene.kind}.`,
    `Book theme: ${safe(scene.theme) ?? 'unspecified'}.`,
    `Scene summary: ${safe(scene.summary) ?? 'warm child-friendly storybook scene'}.`,
    ...(safe(scene.action) ? [`Action: ${safe(scene.action)}.`] : []),
    ...(safe(scene.location) ? [`Location: ${safe(scene.location)}.`] : []),
    ...(safe(scene.mood) ? [`Mood: ${safe(scene.mood)}.`] : []),
    ...(scene.supportingDetails?.map(safe).filter((value): value is string => Boolean(value)).length
      ? [
          `Relevant supporting details: ${scene.supportingDetails.map(safe).filter(Boolean).join('; ')}.`,
        ]
      : []),
    ...(safe(scene.wardrobeChange)
      ? [
          `Scene-required wardrobe change: ${safe(scene.wardrobeChange)}. Preserve all identity traits.`,
        ]
      : []),
    '[END PAGE-SPECIFIC SCENE]',
    NO_TEXT_IN_IMAGE_INSTRUCTION,
    PRESERVE_APPEARANCE_INSTRUCTION,
  ];
  return parts.join('\n');
}
