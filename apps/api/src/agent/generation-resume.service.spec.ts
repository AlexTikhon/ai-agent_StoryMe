import { generateMockImagePng as imageBytes } from '../images/mock-image-producer';
import { describe, expect, it, vi } from 'vitest';
import type { CharacterProfile, GeneratedImageEntry } from '@book/types';
import {
  claimCharacterSheetAssetKey,
  claimImageAssetKey,
  type ImageAssetRef,
  type ImageAssetStorage,
} from '../images/image-asset-storage';
import {
  claimNamespace,
  InvalidGenerationArtifactPointerError,
} from './generation-artifact-namespace';
import { GenerationResumeService, type GenerationResumeBook } from './generation-resume.service';
import { finalizeCharacterProfile } from './character-appearance';
import { Pronouns } from '@book/types';
import { buildGenerationCompatibilityFingerprint } from './generation-compatibility-fingerprint';
import { PROMPT_VERSIONS } from './prompt-versions';

const currentNamespace = claimNamespace('run-current', 2);
const sourceNamespace = claimNamespace('run-source', 1);
const providers = {
  story: { providerName: 'mock', modelName: 'story-model' },
  image: { providerName: 'mock', modelName: 'image-model' },
  character: { providerName: 'mock', modelName: 'character-model' },
};
const compatibilityFingerprint = buildGenerationCompatibilityFingerprint(providers);

class FakeImageAssetStorage implements ImageAssetStorage {
  private readonly data = new Map<string, Buffer>();

  seed(key: string, bytes: Buffer): void {
    this.data.set(key, bytes);
  }

  saveImageAsset = vi.fn(async (key: string, buffer: Buffer): Promise<ImageAssetRef> => {
    this.data.set(key, buffer);
    return { key, path: key, contentType: 'image/png' };
  });

  getImageAsset = vi.fn(async (key: string): Promise<Buffer | undefined> => this.data.get(key));

  copyImageAsset = vi.fn(
    async (sourceKey: string, destinationKey: string): Promise<ImageAssetRef | undefined> => {
      const bytes = this.data.get(sourceKey);
      if (bytes == null) return undefined;
      this.data.set(destinationKey, bytes);
      return { key: destinationKey, path: destinationKey, contentType: 'image/png' };
    },
  );
}

const profile: CharacterProfile = finalizeCharacterProfile({
  childName: 'Mia',
  age: 7,
  visualDescription: 'Mia the explorer',
  faceDescription: 'friendly face',
  hairDescription: 'brown hair',
  outfitDescription: 'yellow spacesuit',
  personalitySummary: 'curious',
  illustrationStyle: 'storybook',
  consistencyPrompt: 'same explorer',
  hasReferencePhoto: false,
  hasCharacterSheet: true,
});

const reusableStory = {
  characterCard: {
    name: 'Mia',
    age: 7,
    pronouns: Pronouns.SheHer,
    appearance: {
      hairColor: 'brown',
      hairStyle: 'wavy',
      eyeColor: 'green',
      skinTone: 'warm',
      distinctiveFeatures: [],
    },
    personality: {
      traits: ['curious'],
      favoriteAnimals: [],
      favoriteColors: [],
      favoriteToys: [],
      hobbies: [],
    },
    visualAnchor: 'Mia the explorer',
    narrativeDescription: 'Mia explores kindly.',
  },
  storyPlan: {
    title: 'Story',
    theme: 'adventure',
    educationalMessage: 'Be curious',
    chapters: [],
    openingHook: 'Once upon a time',
    resolution: 'Mia returned home.',
    pages: [],
  },
  bookPreview: {
    title: 'Story',
    subtitle: '',
    cover: {
      title: 'Story',
      subtitle: '',
      childName: 'Mia',
      illustrationPrompt: 'cover',
    },
    pages: [],
    backCover: { message: 'The end', educationalSummary: 'Be curious' },
    metadata: {
      language: 'en',
      theme: 'adventure',
      childAge: 7,
      totalPages: 0,
      generatedBy: 'mock',
    },
  },
  imageGenerationResult: {
    provider: 'local_mock' as const,
    status: 'complete' as const,
    images: [],
    createdAt: '2026-08-20T00:00:00.000Z',
  },
};

function book(overrides: Partial<GenerationResumeBook> = {}): GenerationResumeBook {
  return {
    id: 'book-1',
    lastGenerationInputHash: 'hash-1',
    lastGenerationCompatibilityFingerprint: compatibilityFingerprint,
    storyPlan: reusableStory.storyPlan,
    characterCard: reusableStory.characterCard,
    bookPreview: reusableStory.bookPreview,
    imageGenerationResult: reusableStory.imageGenerationResult,
    characterProfile: profile,
    lastGenerationRunId: sourceNamespace.runId,
    lastGenerationFencingVersion: sourceNamespace.fencingVersion,
    ...overrides,
  };
}

function image(
  id: string,
  kind: GeneratedImageEntry['kind'],
  pageNumber?: number,
): GeneratedImageEntry {
  return {
    id,
    kind,
    ...(pageNumber !== undefined && { pageNumber }),
    prompt: id,
    provider: 'local_mock',
    status: 'complete',
    imageUrl: `/mock/${id}`,
    altText: id,
    width: 1024,
    height: 1024,
    seed: id,
  };
}

describe('GenerationResumeService', () => {
  it('never fills an unfinished candidate with story fields from the previous publication', async () => {
    const service = new GenerationResumeService(new FakeImageAssetStorage());
    const plan = await service.inspect(
      book({
        generationCheckpoint: {
          version: 1,
          inputHash: 'hash-1',
          compatibilityFingerprint,
          runId: sourceNamespace.runId,
          fencingVersion: 1,
          content: { characterProfile: profile },
          artifacts: {},
        },
      }),
      'hash-1',
      compatibilityFingerprint,
    );
    expect(plan.profile).not.toBeNull();
    expect(plan.story).toBeNull();
    expect(plan.reuse.storyCalls).toBe(0);
  });
  it('enables resume and copies a valid prior character sheet into the current claim', async () => {
    const storage = new FakeImageAssetStorage();
    const sourceKey = claimCharacterSheetAssetKey('book-1', sourceNamespace);
    const currentKey = claimCharacterSheetAssetKey('book-1', currentNamespace);
    storage.seed(sourceKey, imageBytes('prior-sheet'));
    const service = new GenerationResumeService(storage);

    const plan = await service.plan(book(), 'hash-1', compatibilityFingerprint, 'run-current', 2);

    expect(plan).toEqual({
      resumable: true,
      currentNamespace,
      copyForwardSourceNamespace: sourceNamespace,
      priorCharacterProfile: profile,
      reusableStory,
      priorSheet: { status: 'valid', key: currentKey },
      canReuseCharacterProfile: true,
    });
    expect(storage.copyImageAsset).toHaveBeenCalledWith(sourceKey, currentKey);
  });

  it('disables source copy-forward when the immutable input hash changed', async () => {
    const storage = new FakeImageAssetStorage();
    const sourceKey = claimCharacterSheetAssetKey('book-1', sourceNamespace);
    storage.seed(sourceKey, imageBytes('stale-sheet'));
    const service = new GenerationResumeService(storage);

    const plan = await service.plan(book(), 'new-hash', compatibilityFingerprint, 'run-current', 2);

    expect(plan.resumable).toBe(false);
    expect(plan.copyForwardSourceNamespace).toBeNull();
    expect(plan.canReuseCharacterProfile).toBe(false);
    expect(plan.priorSheet.status).toBe('missing');
    expect(storage.getImageAsset).not.toHaveBeenCalledWith(sourceKey);
    expect(storage.copyImageAsset).not.toHaveBeenCalled();
  });

  it('disables reuse when a prompt version changes', async () => {
    const storage = new FakeImageAssetStorage();
    const sourceKey = claimCharacterSheetAssetKey('book-1', sourceNamespace);
    storage.seed(sourceKey, imageBytes('prior-sheet'));
    const service = new GenerationResumeService(storage);
    const changedPromptFingerprint = buildGenerationCompatibilityFingerprint(providers, {
      ...PROMPT_VERSIONS,
      story: `${PROMPT_VERSIONS.story}-changed`,
    });

    const plan = await service.plan(book(), 'hash-1', changedPromptFingerprint, 'run-current', 2);

    expect(plan.resumable).toBe(false);
    expect(plan.copyForwardSourceNamespace).toBeNull();
    expect(plan.canReuseCharacterProfile).toBe(false);
    expect(storage.copyImageAsset).not.toHaveBeenCalled();
    expect(await storage.getImageAsset(sourceKey)).toEqual(imageBytes('prior-sheet'));
  });

  it('disables reuse when a selected model changes', async () => {
    const storage = new FakeImageAssetStorage();
    const sourceKey = claimCharacterSheetAssetKey('book-1', sourceNamespace);
    storage.seed(sourceKey, imageBytes('prior-sheet'));
    const service = new GenerationResumeService(storage);
    const changedModelFingerprint = buildGenerationCompatibilityFingerprint({
      ...providers,
      image: { ...providers.image, modelName: 'new-image-model' },
    });

    const plan = await service.plan(book(), 'hash-1', changedModelFingerprint, 'run-current', 2);

    expect(plan.resumable).toBe(false);
    expect(plan.copyForwardSourceNamespace).toBeNull();
    expect(plan.canReuseCharacterProfile).toBe(false);
    expect(storage.copyImageAsset).not.toHaveBeenCalled();
    expect(await storage.getImageAsset(sourceKey)).toEqual(imageBytes('prior-sheet'));
  });

  it('treats a legacy book with missing compatibility metadata as non-resumable', async () => {
    const storage = new FakeImageAssetStorage();
    const sourceKey = claimCharacterSheetAssetKey('book-1', sourceNamespace);
    storage.seed(sourceKey, imageBytes('legacy-sheet'));
    const service = new GenerationResumeService(storage);

    const plan = await service.plan(
      book({ lastGenerationCompatibilityFingerprint: null }),
      'hash-1',
      compatibilityFingerprint,
      'run-current',
      2,
    );

    expect(plan.resumable).toBe(false);
    expect(plan.copyForwardSourceNamespace).toBeNull();
    expect(plan.canReuseCharacterProfile).toBe(false);
    expect(storage.copyImageAsset).not.toHaveBeenCalled();
    expect(await storage.getImageAsset(sourceKey)).toEqual(imageBytes('legacy-sheet'));
  });

  it('reuses a compatible fingerprint and rejects a stale reference revision', async () => {
    const storage = new FakeImageAssetStorage();
    const service = new GenerationResumeService(storage);
    const revisionedProfile = finalizeCharacterProfile(profile, {
      referenceAssetRevision: 'photo-r1',
    });

    const compatible = await service.plan(
      book({ characterProfile: revisionedProfile }),
      'hash-1',
      compatibilityFingerprint,
      'run-current',
      2,
      'photo-r1',
    );
    const incompatible = await service.plan(
      book({ characterProfile: revisionedProfile }),
      'hash-1',
      compatibilityFingerprint,
      'run-current',
      2,
      'photo-r2',
    );

    expect(compatible.canReuseCharacterProfile).toBe(true);
    expect(incompatible.canReuseCharacterProfile).toBe(false);
  });

  it('requires the complete persisted story/preview/image JSON set before resuming', async () => {
    const storage = new FakeImageAssetStorage();
    const service = new GenerationResumeService(storage);

    const plan = await service.plan(
      book({ imageGenerationResult: null, characterProfile: null }),
      'hash-1',
      compatibilityFingerprint,
      'run-current',
      2,
    );

    expect(plan.resumable).toBe(false);
    expect(plan.canReuseCharacterProfile).toBe(false);
    expect(plan.priorSheet).toEqual({ status: 'missing' });
  });

  it('keeps the validated character checkpoint when the story JSON is malformed', async () => {
    const storage = new FakeImageAssetStorage();
    const sourceKey = claimCharacterSheetAssetKey('book-1', sourceNamespace);
    storage.seed(sourceKey, imageBytes('prior-sheet'));
    const service = new GenerationResumeService(storage);

    const plan = await service.plan(
      book({ storyPlan: { title: 'malformed story' } }),
      'hash-1',
      compatibilityFingerprint,
      'run-current',
      2,
    );

    expect(plan.resumable).toBe(false);
    expect(plan.reusableStory).toBeNull();
    expect(plan.canReuseCharacterProfile).toBe(true);
    expect(plan.copyForwardSourceNamespace).toEqual(sourceNamespace);
  });

  it('does not adopt an orphan sheet when the input differs', async () => {
    const storage = new FakeImageAssetStorage();
    const currentKey = claimCharacterSheetAssetKey('book-1', currentNamespace);
    storage.seed(currentKey, imageBytes('current-sheet'));
    const service = new GenerationResumeService(storage);

    const plan = await service.plan(
      book(),
      'changed-hash',
      compatibilityFingerprint,
      'run-current',
      2,
    );

    expect(plan.resumable).toBe(false);
    expect(plan.priorSheet).toEqual({ status: 'missing' });
    expect(storage.copyImageAsset).not.toHaveBeenCalled();
  });

  it('classifies current reuse, source copy, missing, and invalid images independently', async () => {
    const storage = new FakeImageAssetStorage();
    const images = [
      image('cover', 'cover'),
      image('page-1', 'page', 1),
      image('page-2', 'page', 2),
      image('page-3', 'page', 3),
    ];
    storage.seed(
      claimImageAssetKey('book-1', currentNamespace, 'cover'),
      imageBytes('current-cover'),
    );
    storage.seed(
      claimImageAssetKey('book-1', sourceNamespace, 'page', 1),
      imageBytes('source-page'),
    );
    storage.seed(claimImageAssetKey('book-1', sourceNamespace, 'page', 2), Buffer.alloc(0));
    const service = new GenerationResumeService(storage);

    const result = await service.classifyImages(
      'book-1',
      images,
      currentNamespace,
      sourceNamespace,
    );

    expect(result.reusable.map(({ id }) => id).sort()).toEqual(['cover', 'page-1']);
    expect(result.toGenerate.map(({ id }) => id).sort()).toEqual(['page-2', 'page-3']);
    expect(result.missing.map(({ id }) => id)).toEqual(['page-3']);
    expect(result.invalid.map(({ id }) => id)).toEqual(['page-2']);
    expect(storage.copyImageAsset).toHaveBeenCalledWith(
      claimImageAssetKey('book-1', sourceNamespace, 'page', 1),
      claimImageAssetKey('book-1', currentNamespace, 'page', 1),
    );
  });

  it('validates a malformed source pointer even when the book cannot resume', async () => {
    const storage = new FakeImageAssetStorage();
    const service = new GenerationResumeService(storage);

    await expect(
      service.plan(
        book({
          lastGenerationInputHash: null,
          storyPlan: null,
          lastGenerationRunId: 'run-source',
          lastGenerationFencingVersion: null,
        }),
        'new-hash',
        compatibilityFingerprint,
        'run-current',
        2,
      ),
    ).rejects.toBeInstanceOf(InvalidGenerationArtifactPointerError);
  });
});
