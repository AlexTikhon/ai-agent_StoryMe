import { checkpointBook, effectiveGenerationCheckpoint } from './generation-checkpoint';
import { validateImage } from '../images/validated-image';
import { imageKeyForNamespace, characterSheetKeyForNamespace } from '../images/image-asset-storage';
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
  generationCheckpoint?: unknown;
  id: string;
  lastGenerationInputHash: string | null;
  lastGenerationCompatibilityFingerprint: string | null;
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
  priorCharacterDegraded?: boolean;
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
 * to the exact immutable input and a compatible AI pipeline, gates
 * copy-forward accordingly, resolves the character sheet for the current
 * claim, and classifies planned images into reusable vs. regenerate sets.
 * Provider calls and orchestration remain outside this service.
 */
@Injectable()
export class GenerationResumeService {
  private readonly logger = new Logger(GenerationResumeService.name);

  constructor(@Inject(IMAGE_ASSET_STORAGE_TOKEN) private readonly storage: ImageAssetStorage) {}

  /** Shared read-only planner: no copies, writes, providers, or telemetry-based discounts. */
  async inspect(
    book: GenerationResumeBook,
    inputHash: string,
    fingerprint: string,
    referenceAssetRevision?: string | null,
  ) {
    const checkpoint = effectiveGenerationCheckpoint(book.generationCheckpoint);
    const confirmed = async (label: string, key: string) => {
      const manifest = checkpoint?.artifacts[label];
      const storedKey = typeof manifest?.key === 'string' ? manifest.key : key;
      const decoded = await validateImage(await this.storage.getImageAsset(storedKey));
      if (!decoded) return null;
      if (
        checkpoint &&
        !checkpoint.legacy &&
        checkpoint.artifacts?.[label]?.sha256 !== decoded.sha256
      )
        return null;
      return { ...decoded, key: storedKey };
    };
    book = checkpointBook(book);
    const persisted = parsePersistedGenerationState(book);
    const sourceNamespace = resolveLastGenerationNamespace(book);
    const compatible =
      book.lastGenerationInputHash === inputHash &&
      book.lastGenerationCompatibilityFingerprint === fingerprint;
    const profile =
      compatible &&
      (!checkpoint?.content?.characterDegraded ||
        process.env['CHARACTER_FALLBACK_POLICY'] === 'allow_degraded') &&
      persisted.characterProfile &&
      (referenceAssetRevision === undefined ||
        isCharacterFingerprintCompatible(persisted.characterProfile, referenceAssetRevision))
        ? persisted.characterProfile
        : null;
    const story = compatible && profile ? persisted.reusableStory : null;
    const sheetKey = characterSheetKeyForNamespace(book.id, sourceNamespace);
    const sheet = profile?.hasCharacterSheet ? await confirmed('character_sheet', sheetKey) : null;
    const images = story
      ? await Promise.all(
          story.imageGenerationResult.images.map(async (image) => {
            const artifact = await confirmed(
              image.kind === 'page' ? `page_${image.pageNumber}` : image.kind,
              imageKeyForNamespace(book.id, sourceNamespace, image.kind, image.pageNumber),
            );
            return {
              image,
              valid: !!artifact,
              sha256: artifact?.sha256,
              sourceKey: artifact?.key,
            };
          }),
        )
      : [];
    return {
      profile,
      degraded: !!checkpoint?.content?.characterDegraded,
      story,
      sheet,
      sourceNamespace,
      images,
      reuse: {
        storyCalls: story ? 1 : 0,
        characterProfileCalls: profile ? 1 : 0,
        imageCalls: images.filter((image) => image.valid).length + (sheet ? 1 : 0),
      },
    };
  }

  async plan(
    book: GenerationResumeBook,
    inputHash: string,
    compatibilityFingerprint: string,
    runId: string,
    fencingVersion: number,
    referenceAssetRevision?: string | null,
  ): Promise<GenerationResumePlan> {
    const currentNamespace = claimNamespace(runId, fencingVersion);
    const inspected = await this.inspect(
      book,
      inputHash,
      compatibilityFingerprint,
      referenceAssetRevision,
    );
    const resumable = inspected.story !== null;
    const priorCharacterProfile = inspected.profile;
    const fingerprintCompatible = priorCharacterProfile !== null;
    const copyForwardSourceNamespace = fingerprintCompatible ? inspected.sourceNamespace : null;
    const priorSheet =
      priorCharacterProfile && inspected.sheet
        ? await this.resolveCharacterSheet(
            book.id,
            priorCharacterProfile,
            currentNamespace,
            copyForwardSourceNamespace,
            inspected.sheet.sha256,
            inspected.sheet.key,
          )
        : ({ status: 'missing' } as const);

    return {
      resumable,
      currentNamespace,
      copyForwardSourceNamespace,
      priorCharacterProfile,
      ...(inspected.degraded && { priorCharacterDegraded: true }),
      reusableStory: inspected.story,
      priorSheet,
      canReuseCharacterProfile: fingerprintCompatible,
    };
  }

  async classifyImages(
    bookId: string,
    images: GeneratedImageEntry[],
    currentNamespace: ClaimArtifactNamespace,
    sourceNamespace: GenerationArtifactNamespace | null,
    allowedLabels?: readonly string[],
    onReused?: (label: string, key: string, buffer: Buffer) => Promise<void>,
    expectedHashes?: Readonly<Record<string, string>>,
    sourceKeys?: Readonly<Record<string, string>>,
  ): Promise<ImageReuseClassification> {
    const resolutions = await Promise.all(
      images.map(async (image) => {
        const label = image.kind === 'page' ? `page_${image.pageNumber}` : image.kind;
        if (allowedLabels && !allowedLabels.includes(label))
          return { image, resolution: { outcome: 'regenerate', sourceStatus: 'missing' } as const };
        const resolution = await resolveImageArtifact({
          storage: this.storage,
          bookId,
          currentNamespace,
          sourceNamespace,
          kind: image.kind,
          pageNumber: image.pageNumber,
          expectedSha256: expectedHashes?.[label],
          sourceKey: sourceKeys?.[label],
        });
        if (onReused && resolution.outcome !== 'regenerate') {
          const bytes = await this.storage.getImageAsset(resolution.key);
          if (bytes) await onReused(label, resolution.key, bytes);
        }
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
    expectedSha256: string,
    sourceKey?: string,
  ): Promise<{ status: ResumeAssetStatus; key?: string }> {
    if (!profile.hasCharacterSheet) return { status: 'missing' };
    const resolution = await resolveCharacterSheetArtifact({
      storage: this.storage,
      bookId,
      currentNamespace,
      sourceNamespace,
      expectedSha256,
      ...(sourceKey && { sourceKey }),
    });
    if (resolution.outcome === 'reused' || resolution.outcome === 'copied') {
      return { status: 'valid', key: resolution.key };
    }
    return { status: resolution.sourceStatus === 'invalid' ? 'invalid' : 'missing' };
  }
}
