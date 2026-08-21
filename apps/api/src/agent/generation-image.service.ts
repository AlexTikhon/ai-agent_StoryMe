import { Injectable, Logger } from '@nestjs/common';
import type { CharacterCard, GeneratedImageEntry, ImageGenerationResult } from '@book/types';
import type { ImageReference } from '../images/image-generation-provider';
import type {
  ClaimArtifactNamespace,
  GenerationArtifactNamespace,
} from './generation-artifact-namespace';
import { CharacterReferenceStage } from './character-reference.stage';
import { GenerationResultCollector } from './generation-result.collector';
import { GenerationResumeService } from './generation-resume.service';
import { ImageGenerationStage, imageAssetLabel } from './image-generation.stage';
import type { GenerationProviderTelemetry } from './generation-provider-telemetry';

export interface GenerationImagePhaseResult {
  imageGenerationResult: ImageGenerationResult;
  characterReference: ImageReference | undefined;
  reusableImages: GeneratedImageEntry[];
  missingImagesBefore: GeneratedImageEntry[];
  invalidImagesBefore: GeneratedImageEntry[];
  generatedCount: number;
  failedCount: number;
  attemptedImageCount: number;
  imageDurationMs: number;
}

/** Claim-scoped image reference loading, reuse classification and generation. */
@Injectable()
export class GenerationImageService {
  private readonly logger = new Logger(GenerationImageService.name);

  constructor(
    private readonly referenceStage: CharacterReferenceStage,
    private readonly imageStage: ImageGenerationStage,
    private readonly resumeService: GenerationResumeService,
    private readonly resultCollector: GenerationResultCollector,
  ) {}

  async execute(input: {
    bookId: string;
    characterSheetKey?: string;
    characterCard: CharacterCard;
    result: ImageGenerationResult;
    currentNamespace: ClaimArtifactNamespace;
    sourceNamespace: GenerationArtifactNamespace | null;
    imageProviderName: string | null;
    telemetry: GenerationProviderTelemetry;
    signal?: AbortSignal | undefined;
  }): Promise<GenerationImagePhaseResult> {
    const startedAt = Date.now();
    const { reference: characterReference, loadError: characterReferenceLoadError } =
      await this.referenceStage.loadReference(input.bookId, input.characterSheetKey);
    const classified = await this.resumeService.classifyImages(
      input.bookId,
      input.result.images,
      input.currentNamespace,
      input.sourceNamespace,
    );

    if (classified.reusable.length > 0) {
      this.logger.log(
        `Book ${input.bookId}: reusing ${classified.reusable.length} already-generated illustration(s) (${classified.reusable
          .map(imageAssetLabel)
          .join(', ')}); generating ${classified.toGenerate.length} remaining.`,
      );
    }

    const generation = await this.imageStage.execute({
      bookId: input.bookId,
      characterCard: input.characterCard,
      images: classified.toGenerate,
      ...(characterReference && { characterReference }),
      namespace: input.currentNamespace,
      telemetry: input.telemetry,
      signal: input.signal,
    });
    this.logger.log(
      `Image generation for book ${input.bookId}: ${generation.generatedCount} generated, ${classified.reusable.length} reused, ${generation.failedCount} failed, ${input.result.images.length} planned, characterReferenceAvailable=${characterReference !== undefined}, characterReferenceUsedForImages=${generation.usedCharacterReference}.`,
    );

    return {
      imageGenerationResult: this.resultCollector.collectImageResult({
        result: input.result,
        imageProviderName: input.imageProviderName,
        reusableImageCount: classified.reusable.length,
        attemptedImageCount: classified.toGenerate.length,
        generation,
        characterReferenceAvailable: characterReference !== undefined,
        characterReferenceSupplied: characterReference !== undefined,
        ...(characterReferenceLoadError !== undefined && { characterReferenceLoadError }),
        providerUsage: input.telemetry.snapshot(),
      }),
      characterReference,
      reusableImages: classified.reusable,
      missingImagesBefore: classified.missing,
      invalidImagesBefore: classified.invalid,
      generatedCount: generation.generatedCount,
      failedCount: generation.failedCount,
      attemptedImageCount: classified.toGenerate.length,
      imageDurationMs: Date.now() - startedAt,
    };
  }
}
