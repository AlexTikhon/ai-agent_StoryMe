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

const currentNamespace = claimNamespace('run-current', 2);
const sourceNamespace = claimNamespace('run-source', 1);

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

function book(overrides: Partial<GenerationResumeBook> = {}): GenerationResumeBook {
  return {
    id: 'book-1',
    lastGenerationInputHash: 'hash-1',
    storyPlan: { title: 'Story' },
    characterCard: { name: 'Mia' },
    bookPreview: { pages: [] },
    imageGenerationResult: { images: [] },
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
  it('enables resume and copies a valid prior character sheet into the current claim', async () => {
    const storage = new FakeImageAssetStorage();
    const sourceKey = claimCharacterSheetAssetKey('book-1', sourceNamespace);
    const currentKey = claimCharacterSheetAssetKey('book-1', currentNamespace);
    storage.seed(sourceKey, Buffer.from('prior-sheet'));
    const service = new GenerationResumeService(storage);

    const plan = await service.plan(book(), 'hash-1', 'run-current', 2);

    expect(plan).toEqual({
      resumable: true,
      currentNamespace,
      copyForwardSourceNamespace: sourceNamespace,
      priorCharacterProfile: profile,
      priorSheet: { status: 'valid', key: currentKey },
      canReuseCharacterProfile: true,
    });
    expect(storage.copyImageAsset).toHaveBeenCalledWith(sourceKey, currentKey);
  });

  it('disables source copy-forward when the immutable input hash changed', async () => {
    const storage = new FakeImageAssetStorage();
    const sourceKey = claimCharacterSheetAssetKey('book-1', sourceNamespace);
    storage.seed(sourceKey, Buffer.from('stale-sheet'));
    const service = new GenerationResumeService(storage);

    const plan = await service.plan(book(), 'new-hash', 'run-current', 2);

    expect(plan.resumable).toBe(false);
    expect(plan.copyForwardSourceNamespace).toBeNull();
    expect(plan.canReuseCharacterProfile).toBe(false);
    expect(plan.priorSheet.status).toBe('missing');
    expect(storage.getImageAsset).not.toHaveBeenCalledWith(sourceKey);
    expect(storage.copyImageAsset).not.toHaveBeenCalled();
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
      'run-current',
      2,
      'photo-r1',
    );
    const incompatible = await service.plan(
      book({ characterProfile: revisionedProfile }),
      'hash-1',
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
      'run-current',
      2,
    );

    expect(plan.resumable).toBe(false);
    expect(plan.canReuseCharacterProfile).toBe(false);
    expect(plan.priorSheet).toEqual({ status: 'missing' });
  });

  it('still reuses a valid current-claim sheet on non-resumable same-claim re-entry', async () => {
    const storage = new FakeImageAssetStorage();
    const currentKey = claimCharacterSheetAssetKey('book-1', currentNamespace);
    storage.seed(currentKey, Buffer.from('current-sheet'));
    const service = new GenerationResumeService(storage);

    const plan = await service.plan(book(), 'changed-hash', 'run-current', 2);

    expect(plan.resumable).toBe(false);
    expect(plan.priorSheet).toEqual({ status: 'valid', key: currentKey });
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
      Buffer.from('current-cover'),
    );
    storage.seed(
      claimImageAssetKey('book-1', sourceNamespace, 'page', 1),
      Buffer.from('source-page'),
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
        'run-current',
        2,
      ),
    ).rejects.toBeInstanceOf(InvalidGenerationArtifactPointerError);
  });
});
