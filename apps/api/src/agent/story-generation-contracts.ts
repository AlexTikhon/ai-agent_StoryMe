import {
  DEFAULT_BOOK_PAGE_COUNT,
  MAX_BOOK_PAGE_COUNT,
  MIN_BOOK_PAGE_COUNT,
  type BookPreview,
  type CharacterCard,
  type CharacterProfile,
  type IllustrationPlan,
  type ImageGenerationResult,
  type PagePlan,
  type QualityReport,
  type StoryPlan,
} from '@book/types';
import type { ProviderExecutionOptions } from '../common/provider-execution';

export const NO_TEXT_IN_IMAGE_INSTRUCTION = 'No text in image.';
export const PRESERVE_APPEARANCE_INSTRUCTION = "Do not change the main character's appearance.";

export function buildCharacterConsistencyBlock(characterProfile: CharacterProfile): string {
  const lockedDescription =
    characterProfile.lockedVisualDescription ??
    [
      characterProfile.consistencyPrompt,
      `Hairstyle: ${characterProfile.hairDescription}.`,
      `Face: ${characterProfile.faceDescription}.`,
      `Outfit: ${characterProfile.outfitDescription}.`,
      `Approximate age: ${characterProfile.age}.`,
      `Illustration style: ${characterProfile.illustrationStyle}.`,
    ].join(' ');
  const negativeConstraints =
    characterProfile.negativeConstraints && characterProfile.negativeConstraints.length > 0
      ? `Avoid: ${characterProfile.negativeConstraints.join(', ')}.`
      : '';
  return [
    lockedDescription,
    negativeConstraints,
    NO_TEXT_IN_IMAGE_INSTRUCTION,
    PRESERVE_APPEARANCE_INSTRUCTION,
  ].join(' ');
}

export interface StoryGenerationInput {
  bookId: string;
  childName: string;
  childAge: number;
  theme: string;
  language: string;
  pageCount?: number | undefined;
  educationalMessage?: string | undefined;
  characterProfile: CharacterProfile;
}

export function resolveTargetPageCount(pageCount: number | undefined): number {
  if (typeof pageCount !== 'number' || !Number.isFinite(pageCount)) {
    return DEFAULT_BOOK_PAGE_COUNT;
  }
  return Math.min(MAX_BOOK_PAGE_COUNT, Math.max(MIN_BOOK_PAGE_COUNT, Math.floor(pageCount)));
}

export type ResolvedPagePlan = PagePlan & {
  storyText: string;
  illustration: IllustrationPlan;
};

export interface StoryGenerationResult {
  characterCard: CharacterCard;
  storyPlan: StoryPlan & { pages: ResolvedPagePlan[] };
  bookPreview: BookPreview;
  imageGenerationResult: ImageGenerationResult;
}

export interface StoryRepairInput {
  generationInput: StoryGenerationInput;
  candidate: StoryGenerationResult;
  qualityReport: QualityReport;
}

export interface StoryGenerationProvider {
  readonly providerName?: string;
  readonly modelName?: string;
  readonly promptVersion?: string;
  generateStory(
    input: StoryGenerationInput,
    options?: ProviderExecutionOptions,
  ): Promise<StoryGenerationResult>;
  repairStory?(
    input: StoryRepairInput,
    options?: ProviderExecutionOptions,
  ): Promise<StoryGenerationResult>;
}

export const STORY_GENERATION_PROVIDER_TOKEN = 'STORY_GENERATION_PROVIDER';
