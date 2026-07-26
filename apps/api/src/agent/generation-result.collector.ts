import type {
  GeneratedImageEntry,
  GenerationProviderUsage,
  ImageGenerationResult,
  ResumeDiagnostics,
} from '@book/types';
import { AgentLogStatus, AgentStep, Prisma } from '@prisma/client';
import type { CharacterBuildStageOutput } from './character-reference.stage';
import type { GenerationOutcome } from './generation-outcome';
import type { ImageGenerationStageOutput } from './image-generation.stage';
import { imageAssetLabel } from './image-generation.stage';

export type CollectedAssetStatus = 'valid' | 'missing' | 'invalid';

export interface CollectImageResultInput {
  result: ImageGenerationResult;
  imageProviderName: string | null;
  reusableImageCount: number;
  attemptedImageCount: number;
  generation: ImageGenerationStageOutput;
  characterReferenceAvailable: boolean;
  characterReferenceSupplied: boolean;
  characterReferenceLoadError?: string;
  providerUsage: GenerationProviderUsage;
}

export interface CollectResumeDiagnosticsInput {
  resumable: boolean;
  images: GeneratedImageEntry[];
  priorSheetStatus: CollectedAssetStatus;
  pdfStatusBefore: CollectedAssetStatus;
  reusableImages: GeneratedImageEntry[];
  missingImagesBefore: GeneratedImageEntry[];
  invalidImagesBefore: GeneratedImageEntry[];
  generatedImageCount: number;
  skippedStoryGeneration: boolean;
  skippedCharacterProfileGeneration: boolean;
  skippedCharacterSheetGeneration: boolean;
  missingAssetsAfterRetry: string[];
  pdfRenderSucceeded: boolean;
  finalBookStatus: GenerationOutcome['status'];
}

export interface CollectGenerationOutcomeInput {
  bookId: string;
  traceId: string;
  generationTimeMs: number;
  aiModelVersions: Record<string, string>;
  imageGenerationResult: ImageGenerationResult;
  previewPdfUrl: string | null;
  finalStatus: GenerationOutcome['status'];
  pdfRenderError?: string;
  charBuildResult: CharacterBuildStageOutput;
  storyProviderName: string | null;
  storyModelName: string | null;
  imageProviderName: string | null;
  imageModelName: string | null;
  storyDurationMs: number;
  imageDurationMs: number;
  layoutDurationMs: number;
  pdfDurationMs: number;
  failedImageCount: number;
  attemptedImageCount: number;
  layoutStep: AgentStep;
  pdfStep: AgentStep;
}

export interface CollectStoryFailureOutcomeInput {
  bookId: string;
  traceId: string;
  generationTimeMs: number;
  aiModelVersions: Record<string, string>;
  characterProfileUpdateData: Prisma.BookUpdateInput;
  charBuildResult: CharacterBuildStageOutput;
  storyProviderName: string | null;
  storyModelName: string | null;
  errorMessage: string;
}

/**
 * Pure result-assembly boundary for the generation pipeline. It folds
 * provider telemetry into the persisted image result, builds resume
 * diagnostics, and produces the terminal GenerationOutcome/AgentLog batch.
 * All provider, storage, and database work stays outside this collector.
 */
export class GenerationResultCollector {
  collectStoryFailureOutcome(input: CollectStoryFailureOutcomeInput): GenerationOutcome {
    const {
      bookId,
      traceId,
      generationTimeMs,
      aiModelVersions,
      characterProfileUpdateData,
      charBuildResult,
      storyProviderName,
      storyModelName,
      errorMessage,
    } = input;

    return {
      status: 'failed',
      completedStep: AgentStep.story_plan,
      errorCode: 'GENERATION_FAILED',
      errorMessage,
      failedStep: AgentStep.story_plan,
      bookUpdate: {
        generationTimeMs,
        aiModelVersions,
        ...characterProfileUpdateData,
      },
      agentLogs: [
        {
          bookId,
          agent: 'LocalPipelineAgent',
          step: AgentStep.char_build,
          status: charBuildResult.error ? AgentLogStatus.error : AgentLogStatus.success,
          attempt: 1,
          traceId,
          provider: charBuildResult.providerName,
          model: charBuildResult.modelName,
          durationMs: charBuildResult.durationMs,
          ...(charBuildResult.error && { error: charBuildResult.error }),
        },
        {
          bookId,
          agent: 'LocalPipelineAgent',
          step: AgentStep.story_plan,
          status: AgentLogStatus.error,
          attempt: 1,
          traceId,
          error: errorMessage,
          provider: storyProviderName,
          model: storyModelName,
          durationMs: generationTimeMs,
        },
      ],
    };
  }

  collectImageResult(input: CollectImageResultInput): ImageGenerationResult {
    const {
      result,
      imageProviderName,
      reusableImageCount,
      attemptedImageCount,
      generation,
      characterReferenceAvailable,
      characterReferenceSupplied,
      characterReferenceLoadError,
      providerUsage,
    } = input;
    const priorCharacterReferenceUsedForImages = result.characterReferenceUsedForImages === true;
    const priorImageGenerationMode = result.imageGenerationMode;
    const priorCharacterReferenceAvailable = result.characterReferenceAvailable === true;
    const attemptedWithCharacterReference =
      attemptedImageCount > 0 && generation.generatedCount === 0 && characterReferenceSupplied;

    const collected: ImageGenerationResult = {
      ...result,
      imageByteProvider: imageProviderName,
      generatedImageCount: reusableImageCount + generation.generatedCount,
      failedImageCount: generation.failedCount,
      characterReferenceAvailable: characterReferenceAvailable || priorCharacterReferenceAvailable,
      characterReferenceUsedForImages:
        generation.usedCharacterReference || priorCharacterReferenceUsedForImages,
      imageGenerationMode:
        attemptedImageCount > 0
          ? generation.usedCharacterReference || attemptedWithCharacterReference
            ? 'character-reference-edit'
            : 'text-to-image'
          : (priorImageGenerationMode ?? 'text-to-image'),
      imageFailures: generation.failures,
      providerUsage,
    };
    if (generation.lastError !== undefined) {
      collected.lastImageError = generation.lastError;
    }
    if (characterReferenceLoadError !== undefined) {
      collected.characterReferenceLoadError = characterReferenceLoadError;
    } else {
      delete collected.characterReferenceLoadError;
    }
    return collected;
  }

  collectResumeDiagnostics(input: CollectResumeDiagnosticsInput): ResumeDiagnostics {
    const {
      resumable,
      images,
      priorSheetStatus,
      pdfStatusBefore,
      reusableImages,
      missingImagesBefore,
      invalidImagesBefore,
      generatedImageCount,
      skippedStoryGeneration,
      skippedCharacterProfileGeneration,
      skippedCharacterSheetGeneration,
      missingAssetsAfterRetry,
      pdfRenderSucceeded,
      finalBookStatus,
    } = input;

    return {
      resumeMode: resumable,
      requiredAssets: ['character_sheet', ...images.map(imageAssetLabel), 'pdf'],
      validExistingAssets: [
        ...(priorSheetStatus === 'valid' ? ['character_sheet'] : []),
        ...reusableImages.map(imageAssetLabel),
        ...(pdfStatusBefore === 'valid' ? ['pdf'] : []),
      ],
      missingAssetsBeforeRetry: [
        ...(priorSheetStatus === 'missing' ? ['character_sheet'] : []),
        ...missingImagesBefore.map(imageAssetLabel),
        ...(pdfStatusBefore === 'missing' ? ['pdf'] : []),
      ],
      invalidAssetsBeforeRetry: [
        ...(priorSheetStatus === 'invalid' ? ['character_sheet'] : []),
        ...invalidImagesBefore.map(imageAssetLabel),
        ...(pdfStatusBefore === 'invalid' ? ['pdf'] : []),
      ],
      reusedImageCount: reusableImages.length,
      regeneratedImageCount: generatedImageCount,
      skippedStoryGeneration,
      skippedCharacterProfileGeneration,
      skippedCharacterSheetGeneration,
      skippedExistingImageGeneration: reusableImages.length > 0,
      missingAssetsAfterRetry,
      pdfRenderAttempted: true,
      pdfRenderSucceeded,
      finalBookStatus: finalBookStatus as unknown as ResumeDiagnostics['finalBookStatus'],
    };
  }

  collectOutcome(input: CollectGenerationOutcomeInput): GenerationOutcome {
    const {
      bookId,
      traceId,
      generationTimeMs,
      aiModelVersions,
      imageGenerationResult,
      previewPdfUrl,
      finalStatus,
      pdfRenderError,
      charBuildResult,
      storyProviderName,
      storyModelName,
      imageProviderName,
      imageModelName,
      storyDurationMs,
      imageDurationMs,
      layoutDurationMs,
      pdfDurationMs,
      failedImageCount,
      attemptedImageCount,
      layoutStep,
      pdfStep,
    } = input;

    const bookUpdate: Prisma.BookUpdateInput = {
      generationTimeMs,
      aiModelVersions,
      imageGenerationResult: imageGenerationResult as unknown as Prisma.InputJsonValue,
      ...(previewPdfUrl !== null && { previewPdfUrl }),
    };
    const agentLogs: Prisma.AgentLogCreateManyInput[] = [
      {
        bookId,
        agent: 'LocalPipelineAgent',
        step: AgentStep.char_build,
        status: charBuildResult.error ? AgentLogStatus.error : AgentLogStatus.success,
        attempt: 1,
        traceId,
        provider: charBuildResult.providerName,
        model: charBuildResult.modelName,
        durationMs: charBuildResult.durationMs,
        ...(charBuildResult.error && { error: charBuildResult.error }),
      },
      {
        bookId,
        agent: 'LocalPipelineAgent',
        step: AgentStep.story_plan,
        status: AgentLogStatus.success,
        attempt: 1,
        traceId,
        provider: storyProviderName,
        model: storyModelName,
        durationMs: storyDurationMs,
      },
      ...[
        AgentStep.page_plan,
        AgentStep.story_draft,
        AgentStep.illust_plan,
        AgentStep.preview_ready,
      ].map((step): Prisma.AgentLogCreateManyInput => ({
        bookId,
        agent: 'LocalPipelineAgent',
        step,
        status: AgentLogStatus.success,
        attempt: 1,
        traceId,
        provider: storyProviderName,
        model: storyModelName,
      })),
      {
        bookId,
        agent: 'LocalPipelineAgent',
        step: AgentStep.image_gen,
        status: failedImageCount > 0 ? AgentLogStatus.error : AgentLogStatus.success,
        attempt: 1,
        traceId,
        provider: imageProviderName,
        model: imageModelName,
        durationMs: imageDurationMs,
        ...(failedImageCount > 0 && {
          error: `${failedImageCount} of ${attemptedImageCount} attempted image(s) failed to generate; PDF rendering will fail below unless every page's illustration is otherwise available.`,
        }),
      },
      {
        bookId,
        agent: 'LocalPipelineAgent',
        step: layoutStep,
        status: AgentLogStatus.success,
        attempt: 1,
        traceId,
        durationMs: layoutDurationMs,
      },
      {
        bookId,
        agent: 'LocalPipelineAgent',
        step: pdfStep,
        status: pdfRenderError ? AgentLogStatus.error : AgentLogStatus.success,
        attempt: 1,
        traceId,
        durationMs: pdfDurationMs,
        ...(pdfRenderError && { error: pdfRenderError }),
      },
    ];

    return {
      status: finalStatus,
      completedStep: pdfStep,
      bookUpdate,
      ...(pdfRenderError && {
        errorCode: 'GENERATION_FAILED',
        errorMessage: pdfRenderError,
        failedStep: pdfStep,
      }),
      agentLogs,
    };
  }
}
