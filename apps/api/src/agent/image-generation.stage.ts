import { Inject, Injectable, Logger } from '@nestjs/common';
import { AgentStep } from '@prisma/client';
import type {
  CharacterCard,
  GeneratedImageEntry,
  GenerationProviderName,
  ImageGenerationFailureDetail,
} from '@book/types';
import {
  claimImageAssetKey,
  IMAGE_ASSET_STORAGE_TOKEN,
  type ImageAssetStorage,
} from '../images/image-asset-storage';
import {
  assertCompleteBookImageBudget,
  IMAGE_GENERATION_PROVIDER_TOKEN,
  hasImageGenerationFailureDetails,
  resolveMaxGeneratedImagesPerBook,
  type ImageGenerationProvider,
  type ImageReference,
} from '../images/image-generation-provider';
import type { ClaimArtifactNamespace } from './generation-artifact-namespace';
import { GenerationProviderTelemetry } from './generation-provider-telemetry';
import type { GenerationStage } from './generation-stage';
import {
  classifyProviderFailure,
  isProviderCancellationError,
  throwIfAborted,
} from '../common/provider-execution';

export interface ImageGenerationStageInput {
  bookId: string;
  characterCard: CharacterCard;
  images: GeneratedImageEntry[];
  characterReference?: ImageReference;
  namespace: ClaimArtifactNamespace;
  telemetry: GenerationProviderTelemetry;
  signal?: AbortSignal | undefined;
}

export interface ImageGenerationStageOutput {
  generatedCount: number;
  failedCount: number;
  lastError?: string;
  usedCharacterReference: boolean;
  failures: ImageGenerationFailureDetail[];
}

type ImageEntryGenerationOutcome =
  | { kind: 'generated'; usedCharacterReference: boolean }
  | { kind: 'failed'; message: string; failure: ImageGenerationFailureDetail };

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
@Injectable()
export class ImageGenerationStage implements GenerationStage<
  ImageGenerationStageInput,
  ImageGenerationStageOutput
> {
  readonly step = AgentStep.image_gen;
  private readonly logger = new Logger(ImageGenerationStage.name);

  constructor(
    @Inject(IMAGE_ASSET_STORAGE_TOKEN)
    private readonly storage: ImageAssetStorage,
    @Inject(IMAGE_GENERATION_PROVIDER_TOKEN)
    private readonly provider: ImageGenerationProvider,
  ) {}

  async execute({
    bookId,
    characterCard,
    images,
    characterReference,
    namespace,
    telemetry,
    signal,
  }: ImageGenerationStageInput): Promise<ImageGenerationStageOutput> {
    if (this.provider.providerName === 'openai') {
      assertCompleteBookImageBudget(images.length, resolveMaxGeneratedImagesPerBook());
    }

    const resolvedProviderName = providerName(this.provider.providerName);
    const modelName = this.provider.modelName;
    const attemptedRequestMode: ImageGenerationFailureDetail['requestMode'] = characterReference
      ? 'character-reference-edit'
      : 'text-to-image';

    const outcomes = await Promise.all(
      images.map(async (image) => {
        try {
          throwIfAborted(signal);
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
            execute: (options) =>
              this.provider.generateImage(
                {
                  bookId,
                  entry: image,
                  characterCard,
                  ...(characterReference && { characterReference }),
                },
                { ...options, ...(signal && { signal }) },
              ),
          });
          throwIfAborted(signal);
          const key = claimImageAssetKey(bookId, namespace, image.kind, image.pageNumber);
          await this.storage.saveImageAsset(key, buffer, contentType);
          return {
            kind: 'generated',
            usedCharacterReference: usedReference === true,
          } satisfies ImageEntryGenerationOutcome;
        } catch (err) {
          throwIfAborted(signal);
          if (isProviderCancellationError(err)) throw err;
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Image generation/save failed for entry "${image.id}" (book ${bookId}): ${message}. Falling back to a placeholder for this entry.`,
          );
          const details = hasImageGenerationFailureDetails(err) ? err.details : {};
          return {
            kind: 'failed',
            message,
            failure: {
              assetLabel: imageAssetLabel(image),
              provider: resolvedProviderName,
              ...(modelName && { model: modelName }),
              failureKind: details.failureKind ?? classifyProviderFailure(err),
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
              ...(details.retryDecision !== undefined && {
                retryDecision: details.retryDecision,
              }),
            },
          } satisfies ImageEntryGenerationOutcome;
        }
      }),
    );

    // Promise.all retains input order even when calls finish out of order.
    // Aggregate only after completion so diagnostics never depend on timing.
    const failures = outcomes.flatMap((outcome) =>
      outcome.kind === 'failed' ? [outcome.failure] : [],
    );
    const failureMessages = outcomes.flatMap((outcome) =>
      outcome.kind === 'failed' ? [outcome.message] : [],
    );
    const generatedCount = outcomes.filter((outcome) => outcome.kind === 'generated').length;
    const failedCount = failures.length;
    const usedCharacterReference = outcomes.some(
      (outcome) => outcome.kind === 'generated' && outcome.usedCharacterReference,
    );
    const lastError = failureMessages.at(-1);

    return {
      generatedCount,
      failedCount,
      usedCharacterReference,
      failures,
      ...(lastError !== undefined && { lastError }),
    };
  }
}
