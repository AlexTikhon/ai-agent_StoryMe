import type { CharacterProfile, GeneratedImageEntry } from '@book/types';
import { IMAGE_ASSET_STORAGE_TOKEN, type ImageAssetStorage } from '../images/image-asset-storage';
import {
  claimNamespace,
  resolveLastGenerationNamespace,
  type ClaimArtifactNamespace,
  type GenerationArtifactNamespace,
} from './generation-artifact-namespace';
import { resolveCharacterSheetArtifact, resolveImageArtifact } from './generation-claim-artifacts';
import { isCharacterFingerprintCompatible } from './character-appearance';
import type { StoryGenerationResult } from './story-generation-provider';
import { parsePersistedGenerationState } from './persisted-generation-state';
import { Inject, Injectable, Logger } from '@nestjs/common';

export interface GenerationResumeBook {
  id: string;
  lastGenerationInputHash: string | null;
  storyPlan: unknown;
  characterCard: unknown;
  bookPreview: unknown;
  imageGenerationResult: unknown;
  characterProfile: unknown;
  lastGenerationRunId: string | null;
  lastGenerationFencingVersion: number | null;
}

export type ResumeAssetStatus = 'valid' | 'missing' | 'invalid';

export interface GenerationResumePlan {
  resumable: boolean;
  currentNamespace: ClaimArtifactNamespace;
  copyForwardSourceNamespace: GenerationArtifactNamespace | null;
  priorCharacterProfile: CharacterProfile | null;
  reusableStory: StoryGenerationResult | null;
  priorSheet: {
    status: ResumeAssetStatus;
    key?: string;
  };
  canReuseCharacterProfile: boolean;
}

export interface ImageReuseClassification {
  reusable: GeneratedImageEntry[];
  toGenerate: GeneratedImageEntry[];
  missing: GeneratedImageEntry[];
  invalid: GeneratedImageEntry[];
}

/**
 * Central resume/reuse boundary. It decides whether persisted JSON belongs
 * to the exact immutable input, gates copy-forward accordingly, resolves the
 * character sheet for the current claim, and classifies planned images into
 * reusable vs. regenerate sets. Provider calls and orchestration remain
 * outside this service.
 */
@Injectable()
export class GenerationResumeService {
  private readonly logger = new Logger(GenerationResumeService.name);

  constructor(@Inject(IMAGE_ASSET_STORAGE_TOKEN) private readonly storage: ImageAssetStorage) {}

  async plan(
    book: GenerationResumeBook,
    inputHash: string,
    runId: string,
    fencingVersion: number,
    referenceAssetRevision?: string | null,
  ): Promise<GenerationResumePlan> {
    const currentNamespace = claimNamespace(runId, fencingVersion);
    // Resolve unconditionally so a malformed partial pointer always fails,
    // including on a fresh/non-resumable generation.
    const sourceNamespace = resolveLastGenerationNamespace(book);
    const persisted = parsePersistedGenerationState(book);
    const resumable =
      book.lastGenerationInputHash === inputHash && persisted.reusableStory !== null;
    if (book.lastGenerationInputHash === inputHash && persisted.invalidFields.length > 0) {
      this.logger.warn(
        `Book ${book.id}: reusable persisted generation JSON failed validation (${persisted.invalidFields.join(', ')}); starting safely from scratch.`,
      );
    }
    const priorCharacterProfile = persisted.characterProfile;
    const fingerprintCompatible =
      priorCharacterProfile != null &&
      (referenceAssetRevision === undefined ||
        isCharacterFingerprintCompatible(priorCharacterProfile, referenceAssetRevision));
    const copyForwardSourceNamespace = resumable && fingerprintCompatible ? sourceNamespace : null;
    const priorSheet = priorCharacterProfile
      ? await this.resolveCharacterSheet(
          book.id,
          priorCharacterProfile,
          currentNamespace,
          copyForwardSourceNamespace,
        )
      : ({ status: 'missing' } as const);

    return {
      resumable,
      currentNamespace,
      copyForwardSourceNamespace,
      priorCharacterProfile,
      reusableStory: resumable ? persisted.reusableStory : null,
      priorSheet,
      canReuseCharacterProfile: resumable && fingerprintCompatible,
    };
  }

  async classifyImages(
    bookId: string,
    images: GeneratedImageEntry[],
    currentNamespace: ClaimArtifactNamespace,
    sourceNamespace: GenerationArtifactNamespace | null,
  ): Promise<ImageReuseClassification> {
    const resolutions = await Promise.all(
      images.map(async (image) => {
        const resolution = await resolveImageArtifact({
          storage: this.storage,
          bookId,
          currentNamespace,
          sourceNamespace,
          kind: image.kind,
          pageNumber: image.pageNumber,
        });
        return { image, resolution };
      }),
    );

    const reusable: GeneratedImageEntry[] = [];
    const toGenerate: GeneratedImageEntry[] = [];
    const missing: GeneratedImageEntry[] = [];
    const invalid: GeneratedImageEntry[] = [];
    for (const { image, resolution } of resolutions) {
      if (resolution.outcome === 'reused' || resolution.outcome === 'copied') {
        reusable.push(image);
      } else {
        toGenerate.push(image);
        (resolution.sourceStatus === 'invalid' ? invalid : missing).push(image);
      }
    }

    return { reusable, toGenerate, missing, invalid };
  }

  private async resolveCharacterSheet(
    bookId: string,
    profile: CharacterProfile,
    currentNamespace: ClaimArtifactNamespace,
    sourceNamespace: GenerationArtifactNamespace | null,
  ): Promise<{ status: ResumeAssetStatus; key?: string }> {
    if (!profile.hasCharacterSheet) return { status: 'missing' };
    const resolution = await resolveCharacterSheetArtifact({
      storage: this.storage,
      bookId,
      currentNamespace,
      sourceNamespace,
    });
    if (resolution.outcome === 'reused' || resolution.outcome === 'copied') {
      return { status: 'valid', key: resolution.key };
    }
    return { status: resolution.sourceStatus === 'invalid' ? 'invalid' : 'missing' };
  }
}
