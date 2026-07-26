import { Logger } from '@nestjs/common';
import { AgentStep } from '@prisma/client';
import type {
  CharacterCard,
  GeneratedImageEntry,
  GenerationProviderName,
  ImageGenerationFailureDetail,
} from '@book/types';
import { claimImageAssetKey, type ImageAssetStorage } from '../images/image-asset-storage';
import {
  assertCompleteBookImageBudget,
  hasImageGenerationFailureDetails,
  resolveMaxGeneratedImagesPerBook,
  type ImageGenerationProvider,
  type ImageReference,
} from '../images/image-generation-provider';
import type { ClaimArtifactNamespace } from './generation-artifact-namespace';
import { GenerationProviderTelemetry } from './generation-provider-telemetry';
import type { GenerationStage } from './generation-stage';

export interface ImageGenerationStageInput {
  bookId: string;
  characterCard: CharacterCard;
  images: GeneratedImageEntry[];
  characterReference?: ImageReference;
  namespace: ClaimArtifactNamespace;
  telemetry: GenerationProviderTelemetry;
}

export interface ImageGenerationStageOutput {
  generatedCount: number;
  failedCount: number;
  lastError?: string;
  usedCharacterReference: boolean;
  failures: ImageGenerationFailureDetail[];
}

/** Stable diagnostics label for one planned image entry. */
export function imageAssetLabel(entry: GeneratedImageEntry): string {
  return entry.kind === 'page' ? `page_${entry.pageNumber}` : entry.kind;
}

function providerName(raw: string | undefined): GenerationProviderName {
  return raw === 'mock' || raw === 'openai' ? raw : 'unknown';
}

/**
 * Bounded image-generation stage. It checks the paid complete-book budget
 * before any provider call, generates entries concurrently, persists each
 * claim-scoped asset, and converts per-entry provider/storage failures into
 * safe diagnostics without aborting the remaining batch.
 */
export class ImageGenerationStage implements GenerationStage<
  ImageGenerationStageInput,
  ImageGenerationStageOutput
> {
  readonly step = AgentStep.image_gen;
  private readonly logger = new Logger(ImageGenerationStage.name);

  constructor(
    private readonly storage: ImageAssetStorage,
    private readonly provider: ImageGenerationProvider,
  ) {}

  async execute({
    bookId,
    characterCard,
    images,
    characterReference,
    namespace,
    telemetry,
  }: ImageGenerationStageInput): Promise<ImageGenerationStageOutput> {
    if (this.provider.providerName === 'openai') {
      assertCompleteBookImageBudget(images.length, resolveMaxGeneratedImagesPerBook());
    }

    const resolvedProviderName = providerName(this.provider.providerName);
    const modelName = this.provider.modelName;
    const attemptedRequestMode: ImageGenerationFailureDetail['requestMode'] = characterReference
      ? 'character-reference-edit'
      : 'text-to-image';

    let generatedCount = 0;
    let failedCount = 0;
    let lastError: string | undefined;
    let usedCharacterReference = false;
    const failures: ImageGenerationFailureDetail[] = [];

    await Promise.all(
      images.map(async (image) => {
        try {
          const { buffer, contentType, usedReference } = await telemetry.record({
            operation: 'illustration',
            assetLabel: imageAssetLabel(image),
            provider: resolvedProviderName,
            ...(modelName && { model: modelName }),
            promptVersion: this.provider.promptVersion ?? 'legacy-image-v1',
            promptInput: {
              bookId,
              entry: {
                kind: image.kind,
                pageNumber: image.pageNumber,
                prompt: image.prompt,
                negativePrompt: image.negativePrompt,
                seed: image.seed,
              },
              characterCard,
              characterReferenceSupplied: characterReference !== undefined,
            },
            execute: () =>
              this.provider.generateImage({
                bookId,
                entry: image,
                characterCard,
                ...(characterReference && { characterReference }),
              }),
          });
          const key = claimImageAssetKey(bookId, namespace, image.kind, image.pageNumber);
          await this.storage.saveImageAsset(key, buffer, contentType);
          generatedCount++;
          if (usedReference) usedCharacterReference = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Image generation/save failed for entry "${image.id}" (book ${bookId}): ${message}. Falling back to a placeholder for this entry.`,
          );
          failedCount++;
          lastError = message;
          const details = hasImageGenerationFailureDetails(err) ? err.details : {};
          failures.push({
            assetLabel: imageAssetLabel(image),
            provider: resolvedProviderName,
            ...(modelName && { model: modelName }),
            ...(details.httpStatus !== undefined && { httpStatus: details.httpStatus }),
            ...(details.errorType !== undefined && { errorType: details.errorType }),
            ...(details.errorCode !== undefined && { errorCode: details.errorCode }),
            message,
            attempts: details.attempts ?? 1,
            limiterRetries: details.limiterRetries ?? 0,
            limiterWaitMs: details.limiterWaitMs ?? 0,
            characterReferenceSupplied:
              details.characterReferenceSupplied ?? characterReference !== undefined,
            requestMode: details.requestMode ?? attemptedRequestMode,
            ...(details.timeoutMs !== undefined && { timeoutMs: details.timeoutMs }),
            ...(details.elapsedMs !== undefined && { elapsedMs: details.elapsedMs }),
            ...(details.retryDecision !== undefined && { retryDecision: details.retryDecision }),
          });
        }
      }),
    );

    return {
      generatedCount,
      failedCount,
      usedCharacterReference,
      failures,
      ...(lastError !== undefined && { lastError }),
    };
  }
}
