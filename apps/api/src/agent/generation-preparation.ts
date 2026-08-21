import { Inject, Injectable } from '@nestjs/common';
import type { GenerationExecutionContext } from './generation-execution-context';
import type { StoryGenerationProvider } from './story-generation-provider';
import { STORY_GENERATION_PROVIDER_TOKEN } from './story-generation-provider';
import type { ImageGenerationProvider } from '../images/image-generation-provider';
import { IMAGE_GENERATION_PROVIDER_TOKEN } from '../images/image-generation-provider';
import type { CharacterProfileProvider } from './character-profile-provider';
import { CHARACTER_PROFILE_PROVIDER_TOKEN } from './character-profile-provider';
import {
  GenerationProviderTelemetry,
  requiredPaidProviderCallsForBook,
  resolveMaxPaidProviderCallsPerRun,
} from './generation-provider-telemetry';
import { resolveTargetPageCount } from './story-generation-provider';
import { resolveStoryRepairEnabled } from './story-quality-repair.stage';

export interface ResolvedGenerationInput {
  childName: string;
  childAge: number;
  theme: string;
  language: string;
  pageCount: number | undefined;
  educationalMessage: string | undefined;
  childPhoto?: { assetKey: string; contentType: string; sha256: string; sizeBytes: number };
}

export interface PreparedGenerationContext {
  input: ResolvedGenerationInput;
  targetPageCount: number;
  storyRepairEnabled: boolean;
  providerTelemetry: GenerationProviderTelemetry;
  storyProviderName: string | null;
  storyModelName: string | null;
  imageProviderName: string | null;
  imageModelName: string | null;
  characterProviderName: string | null;
  characterModelName: string | null;
  aiModelVersions: { story: string; image: string };
}

function modelLabel(provider: {
  readonly providerName?: string;
  readonly modelName?: string;
}): string {
  return provider.modelName ?? provider.providerName ?? 'unknown';
}

/** Resolves all mutable-free run preparation exactly once from inputSnapshot. */
export function prepareGeneration(
  ctx: GenerationExecutionContext,
  providers: {
    story: StoryGenerationProvider;
    image: ImageGenerationProvider;
    character: CharacterProfileProvider;
  },
  env: NodeJS.ProcessEnv = process.env,
): PreparedGenerationContext {
  const snapshot = ctx.inputSnapshot;
  const pageCount = snapshot.pageCount ?? undefined;
  const input: ResolvedGenerationInput = {
    childName: snapshot.childName ?? 'Alex',
    childAge: snapshot.childAge ?? 6,
    theme: snapshot.theme ?? 'adventure',
    language: snapshot.language ?? 'en',
    pageCount,
    educationalMessage: snapshot.educationalMessage ?? undefined,
    ...(snapshot.childPhoto && {
      childPhoto: {
        assetKey: snapshot.childPhoto.assetKey,
        contentType: snapshot.childPhoto.contentType,
        sha256: snapshot.childPhoto.sha256,
        sizeBytes: snapshot.childPhoto.sizeBytes,
      },
    }),
  };
  const targetPageCount = resolveTargetPageCount(pageCount);
  const storyRepairEnabled = resolveStoryRepairEnabled(env);
  const plannedPaidCalls = requiredPaidProviderCallsForBook(targetPageCount, {
    storyProvider: providers.story.providerName,
    characterProfileProvider: providers.character.providerName,
    imageProvider: providers.image.providerName,
    storyRepairEnabled,
  });

  return {
    input,
    targetPageCount,
    storyRepairEnabled,
    providerTelemetry: new GenerationProviderTelemetry(
      resolveMaxPaidProviderCallsPerRun(env),
      plannedPaidCalls,
    ),
    storyProviderName: providers.story.providerName ?? null,
    storyModelName: providers.story.modelName ?? null,
    imageProviderName: providers.image.providerName ?? null,
    imageModelName: providers.image.modelName ?? null,
    characterProviderName: providers.character.providerName ?? null,
    characterModelName: providers.character.modelName ?? null,
    aiModelVersions: {
      story: modelLabel(providers.story),
      image: modelLabel(providers.image),
    },
  };
}

/** Nest-owned preparation boundary for immutable input/provider resolution. */
@Injectable()
export class GenerationPreparationService {
  constructor(
    @Inject(STORY_GENERATION_PROVIDER_TOKEN)
    private readonly storyProvider: StoryGenerationProvider,
    @Inject(IMAGE_GENERATION_PROVIDER_TOKEN)
    private readonly imageProvider: ImageGenerationProvider,
    @Inject(CHARACTER_PROFILE_PROVIDER_TOKEN)
    private readonly characterProvider: CharacterProfileProvider,
  ) {}

  prepare(ctx: GenerationExecutionContext): PreparedGenerationContext {
    return prepareGeneration(ctx, {
      story: this.storyProvider,
      image: this.imageProvider,
      character: this.characterProvider,
    });
  }
}
