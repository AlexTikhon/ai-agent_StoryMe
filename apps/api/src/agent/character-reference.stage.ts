import { Inject, Injectable, Logger } from '@nestjs/common';
import { AgentStep } from '@prisma/client';
import type { CharacterProfile, GenerationProviderName } from '@book/types';
import { createHash } from 'node:crypto';
import { CHILD_PHOTO_INTEGRITY_MISMATCH } from '../books/child-photo.constants';
import {
  claimCharacterSheetAssetKey,
  IMAGE_ASSET_STORAGE_TOKEN,
  type ImageAssetStorage,
} from '../images/image-asset-storage';
import {
  IMAGE_GENERATION_PROVIDER_TOKEN,
  type ImageGenerationProvider,
  type ImageReference,
} from '../images/image-generation-provider';
import {
  MockCharacterProfileProvider,
  CHARACTER_PROFILE_PROVIDER_TOKEN,
  type CharacterProfileProvider,
} from './character-profile-provider';
import type { ClaimArtifactNamespace } from './generation-artifact-namespace';
import { GenerationProviderTelemetry } from './generation-provider-telemetry';
import type { GenerationStage } from './generation-stage';
import {
  isProviderCancellationError,
  safeProviderFailureMessage,
  throwIfAborted,
} from '../common/provider-execution';

export interface CharacterReferenceInput {
  childName: string;
  childAge: number;
  theme: string;
  language: string;
  childPhoto?: {
    assetKey: string;
    contentType: string;
    sha256: string;
    sizeBytes: number;
  };
}

export interface CharacterBuildStageInput {
  bookId: string;
  input: CharacterReferenceInput;
  namespace: ClaimArtifactNamespace;
  telemetry: GenerationProviderTelemetry;
  signal?: AbortSignal | undefined;
}

export interface CharacterBuildStageOutput {
  characterProfile: CharacterProfile;
  characterSheetKey?: string;
  providerName: string | null;
  modelName: string | null;
  durationMs: number;
  error?: string;
}

export interface CharacterSheetRegenerationInput {
  bookId: string;
  characterProfile: CharacterProfile;
  namespace: ClaimArtifactNamespace;
  telemetry: GenerationProviderTelemetry;
  signal?: AbortSignal | undefined;
}

export interface CharacterSheetRegenerationOutput {
  characterProfile: CharacterProfile;
  characterSheetKey?: string;
  durationMs: number;
  error?: string;
}

export interface CharacterReferenceLoadOutput {
  reference?: ImageReference;
  loadError?: string;
}

function providerName(raw: string | undefined): GenerationProviderName {
  return raw === 'mock' || raw === 'openai' ? raw : 'unknown';
}

function promptVersion(provider: { readonly promptVersion?: string }, fallback: string): string {
  return provider.promptVersion ?? fallback;
}

/**
 * Owns the complete char_build boundary: immutable child-photo verification,
 * profile-provider fallback, character-sheet generation/storage, resume-only
 * sheet regeneration, and loading the generated sheet as an illustration
 * reference. Book-level resume decisions and pipeline ordering stay in the
 * orchestrator.
 */
@Injectable()
export class CharacterReferenceStage implements GenerationStage<
  CharacterBuildStageInput,
  CharacterBuildStageOutput
> {
  readonly step = AgentStep.char_build;
  private readonly logger = new Logger(CharacterReferenceStage.name);
  private readonly fallbackProfileProvider = new MockCharacterProfileProvider();

  constructor(
    @Inject(IMAGE_ASSET_STORAGE_TOKEN)
    private readonly imageAssetStorage: ImageAssetStorage,
    @Inject(CHARACTER_PROFILE_PROVIDER_TOKEN)
    private readonly profileProvider: CharacterProfileProvider,
    @Inject(IMAGE_GENERATION_PROVIDER_TOKEN)
    private readonly imageProvider: ImageGenerationProvider,
  ) {}

  async execute({
    bookId,
    input,
    namespace,
    telemetry,
    signal,
  }: CharacterBuildStageInput): Promise<CharacterBuildStageOutput> {
    const startedAt = Date.now();
    const { childName, childAge, theme, language } = input;
    const { photo, integrityError } = await this.loadAndVerifyChildPhoto(bookId, input.childPhoto);

    let resolvedProviderName = this.profileProvider.providerName ?? null;
    const modelName = this.profileProvider.modelName ?? null;
    let characterProfile: CharacterProfile;
    let error: string | undefined = integrityError;
    const profilePromptInput = {
      bookId,
      childName,
      childAge,
      theme,
      language,
      childPhoto: input.childPhoto
        ? {
            contentType: input.childPhoto.contentType,
            sha256: input.childPhoto.sha256,
          }
        : null,
    };

    try {
      characterProfile = await telemetry.record({
        operation: 'character_profile',
        provider: providerName(this.profileProvider.providerName),
        ...(this.profileProvider.modelName && { model: this.profileProvider.modelName }),
        promptVersion: promptVersion(this.profileProvider, 'legacy-character-profile-v1'),
        promptInput: profilePromptInput,
        execute: (options) =>
          this.profileProvider.buildProfile(
            {
              bookId,
              childName,
              childAge,
              theme,
              language,
              photo,
              referenceAssetRevision: input.childPhoto?.sha256,
            },
            { ...options, ...(signal && { signal }) },
          ),
      });
    } catch (err) {
      throwIfAborted(signal);
      if (isProviderCancellationError(err)) throw err;
      error = safeProviderFailureMessage(err);
      this.logger.warn(
        `Character profile provider failed for book ${bookId}: ${error}. Falling back to a generic profile.`,
      );
      characterProfile = await telemetry.record({
        operation: 'character_profile',
        provider: providerName(this.fallbackProfileProvider.providerName),
        promptVersion: promptVersion(this.fallbackProfileProvider, 'fallback-character-profile-v1'),
        promptInput: profilePromptInput,
        execute: (options) =>
          this.fallbackProfileProvider.buildProfile(
            {
              bookId,
              childName,
              childAge,
              theme,
              language,
              photo,
              referenceAssetRevision: input.childPhoto?.sha256,
            },
            { ...options, ...(signal && { signal }) },
          ),
      });
      resolvedProviderName = 'mock';
    }

    let characterSheetKey: string | undefined;
    try {
      throwIfAborted(signal);
      const { buffer, contentType } = await this.generateCharacterSheet(
        bookId,
        characterProfile,
        telemetry,
        signal,
      );
      throwIfAborted(signal);
      const key = claimCharacterSheetAssetKey(bookId, namespace);
      await this.imageAssetStorage.saveImageAsset(key, buffer, contentType);
      characterSheetKey = key;
      characterProfile = { ...characterProfile, hasCharacterSheet: true };
    } catch (err) {
      throwIfAborted(signal);
      if (isProviderCancellationError(err)) throw err;
      const sheetError = safeProviderFailureMessage(err);
      this.logger.warn(
        `Character sheet generation/save failed for book ${bookId}: ${sheetError}. Continuing without a character sheet reference image.`,
      );
    }

    return {
      characterProfile,
      ...(characterSheetKey !== undefined && { characterSheetKey }),
      providerName: resolvedProviderName,
      modelName,
      durationMs: Date.now() - startedAt,
      ...(error !== undefined && { error }),
    };
  }

  async regenerateSheet({
    bookId,
    characterProfile,
    namespace,
    telemetry,
    signal,
  }: CharacterSheetRegenerationInput): Promise<CharacterSheetRegenerationOutput> {
    const startedAt = Date.now();
    try {
      throwIfAborted(signal);
      const { buffer, contentType } = await this.generateCharacterSheet(
        bookId,
        characterProfile,
        telemetry,
        signal,
      );
      throwIfAborted(signal);
      const key = claimCharacterSheetAssetKey(bookId, namespace);
      await this.imageAssetStorage.saveImageAsset(key, buffer, contentType);
      return {
        characterProfile: { ...characterProfile, hasCharacterSheet: true },
        characterSheetKey: key,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      throwIfAborted(signal);
      if (isProviderCancellationError(err)) throw err;
      const sheetError = safeProviderFailureMessage(err);
      this.logger.warn(
        `Character sheet regeneration/save failed for book ${bookId} during resume: ${sheetError}. Continuing without a character sheet reference image.`,
      );
      return {
        characterProfile: { ...characterProfile, hasCharacterSheet: false },
        durationMs: Date.now() - startedAt,
        error: sheetError,
      };
    }
  }

  async loadReference(
    bookId: string,
    characterSheetKey: string | undefined,
  ): Promise<CharacterReferenceLoadOutput> {
    if (!characterSheetKey) return {};

    const buffer = await this.imageAssetStorage.getImageAsset(characterSheetKey);
    if (!buffer) {
      const loadError = `Character sheet asset "${characterSheetKey}" for book ${bookId} is recorded as existing but its bytes could not be loaded from image storage; continuing with text-only image generation for this run.`;
      this.logger.error(loadError);
      return { loadError };
    }

    return { reference: { buffer, contentType: 'image/png' } };
  }

  private async loadAndVerifyChildPhoto(
    bookId: string,
    childPhoto: CharacterReferenceInput['childPhoto'],
  ): Promise<{ photo?: { base64: string; contentType: string }; integrityError?: string }> {
    if (!childPhoto) return {};

    const bytes = await this.imageAssetStorage.getImageAsset(childPhoto.assetKey);
    if (!bytes) {
      this.logger.warn(
        `Book ${bookId} has childPhoto asset "${childPhoto.assetKey}" but no bytes were found in image storage; building character profile without a photo.`,
      );
      return {};
    }

    if (bytes.length !== childPhoto.sizeBytes) {
      const integrityError = `${CHILD_PHOTO_INTEGRITY_MISMATCH}: childPhoto asset "${childPhoto.assetKey}" for book ${bookId} is ${bytes.length} bytes, expected ${childPhoto.sizeBytes} — refusing to use it.`;
      this.logger.error(integrityError);
      return { integrityError };
    }

    const actualSha256 = createHash('sha256').update(bytes).digest('hex');
    if (actualSha256 !== childPhoto.sha256) {
      const integrityError = `${CHILD_PHOTO_INTEGRITY_MISMATCH}: childPhoto asset "${childPhoto.assetKey}" for book ${bookId} has sha256 ${actualSha256}, expected ${childPhoto.sha256} — refusing to use it.`;
      this.logger.error(integrityError);
      return { integrityError };
    }

    return { photo: { base64: bytes.toString('base64'), contentType: childPhoto.contentType } };
  }

  private generateCharacterSheet(
    bookId: string,
    characterProfile: CharacterProfile,
    telemetry: GenerationProviderTelemetry,
    signal?: AbortSignal,
  ) {
    return telemetry.record({
      operation: 'character_sheet',
      provider: providerName(this.imageProvider.providerName),
      ...(this.imageProvider.modelName && { model: this.imageProvider.modelName }),
      promptVersion:
        this.imageProvider.characterReferencePromptVersion ??
        promptVersion(this.imageProvider, 'legacy-character-reference-v1'),
      promptInput: { bookId, characterProfile },
      execute: (options) =>
        this.imageProvider.generateCharacterSheet(
          {
            bookId,
            characterProfile,
          },
          { ...options, ...(signal && { signal }) },
        ),
    });
  }
}
