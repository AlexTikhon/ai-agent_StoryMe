import type { CharacterProfile } from '@book/types';
import {
  bookPreviewSchema,
  characterCardSchema,
  characterProfileSchema,
  imageGenerationResultSchema,
  storyPlanSchema,
} from '../books/books.schemas';
import type { StoryGenerationResult } from './story-generation-provider';

export type PersistedGenerationField =
  'characterProfile' | 'characterCard' | 'storyPlan' | 'bookPreview' | 'imageGenerationResult';

export interface PersistedGenerationJson {
  characterProfile: unknown;
  characterCard: unknown;
  storyPlan: unknown;
  bookPreview: unknown;
  imageGenerationResult: unknown;
}

export interface ParsedPersistedGenerationState {
  characterProfile: CharacterProfile | null;
  reusableStory: StoryGenerationResult | null;
  invalidFields: PersistedGenerationField[];
}

/**
 * Runtime boundary for Prisma Json reused by generation. It deliberately
 * returns only field labels on failure so callers can log a useful reason
 * without ever serializing child data, story text, prompts, tokens or bytes.
 */
export function parsePersistedGenerationState(
  value: PersistedGenerationJson,
): ParsedPersistedGenerationState {
  const invalidFields: PersistedGenerationField[] = [];

  const profile = characterProfileSchema.safeParse(value.characterProfile);
  if (!profile.success && value.characterProfile != null) invalidFields.push('characterProfile');

  const card = characterCardSchema.safeParse(value.characterCard);
  if (!card.success && value.characterCard != null) invalidFields.push('characterCard');
  const storyPlan = storyPlanSchema.safeParse(value.storyPlan);
  if (!storyPlan.success && value.storyPlan != null) invalidFields.push('storyPlan');
  const preview = bookPreviewSchema.safeParse(value.bookPreview);
  if (!preview.success && value.bookPreview != null) invalidFields.push('bookPreview');
  const imageResult = imageGenerationResultSchema.safeParse(value.imageGenerationResult);
  if (!imageResult.success && value.imageGenerationResult != null) {
    invalidFields.push('imageGenerationResult');
  }

  const reusableStory =
    card.success && storyPlan.success && preview.success && imageResult.success
      ? ({
          characterCard: card.data,
          storyPlan: storyPlan.data,
          bookPreview: preview.data,
          imageGenerationResult: imageResult.data,
        } as StoryGenerationResult)
      : null;

  return {
    characterProfile: profile.success ? (profile.data as CharacterProfile) : null,
    reusableStory,
    invalidFields,
  };
}
