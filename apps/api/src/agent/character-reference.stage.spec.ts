import { generateMockImagePng as imageBytes } from '../images/mock-image-producer';
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterProfile } from '@book/types';
import type { ImageAssetStorage } from '../images/image-asset-storage';
import type { ImageGenerationProvider } from '../images/image-generation-provider';
import {
  MockCharacterProfileProvider,
  type CharacterProfileProvider,
} from './character-profile-provider';
import { CharacterReferenceStage } from './character-reference.stage';
import { claimNamespace } from './generation-artifact-namespace';
import { GenerationProviderTelemetry } from './generation-provider-telemetry';
import { ProviderCancellationError } from '../common/provider-execution';

const namespace = claimNamespace('run-1', 2);
const sheetKey = 'books/book-1/runs/run-1/claims/2/character-sheet';

function makeStorage() {
  return {
    getImageAsset: vi.fn(),
    saveImageAsset: vi.fn().mockResolvedValue({
      key: sheetKey,
      path: sheetKey,
      contentType: 'image/png',
    }),
  } as unknown as ImageAssetStorage & {
    getImageAsset: ReturnType<typeof vi.fn>;
    saveImageAsset: ReturnType<typeof vi.fn>;
  };
}

function makeImageProvider() {
  return {
    providerName: 'mock',
    promptVersion: 'test-image-v1',
    characterReferencePromptVersion: 'character-reference-v3',
    generateImage: vi.fn(),
    generateCharacterSheet: vi.fn().mockResolvedValue({
      buffer: imageBytes('sheet-bytes'),
      contentType: 'image/png',
    }),
  } as ImageGenerationProvider & {
    generateCharacterSheet: ReturnType<typeof vi.fn>;
  };
}

function makeInput(photo?: Buffer) {
  return {
    bookId: 'book-1',
    input: {
      childName: 'Mia',
      childAge: 7,
      theme: 'space',
      language: 'en',
      ...(photo && {
        childPhoto: {
          assetKey: 'book-1/child-photo',
          contentType: 'image/jpeg',
          sha256: createHash('sha256').update(photo).digest('hex'),
          sizeBytes: photo.length,
        },
      }),
    },
    namespace,
    telemetry: new GenerationProviderTelemetry(10, 0),
  };
}

describe('CharacterReferenceStage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('verifies the immutable photo, builds a profile, and saves a claim-scoped sheet', async () => {
    const photo = imageBytes('verified-photo');
    const storage = makeStorage();
    storage.getImageAsset.mockResolvedValue(photo);
    const buildProfile = vi
      .fn()
      .mockImplementation((input) => new MockCharacterProfileProvider().buildProfile(input));
    const profileProvider = {
      providerName: 'mock',
      promptVersion: 'test-profile-v1',
      buildProfile,
    } as CharacterProfileProvider;
    const imageProvider = makeImageProvider();
    const telemetry = new GenerationProviderTelemetry(10, 0);
    const stage = new CharacterReferenceStage(storage, profileProvider, imageProvider);

    const result = await stage.execute({ ...makeInput(photo), telemetry });

    expect(stage.step).toBe('char_build');
    expect(buildProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        photo: { base64: photo.toString('base64'), contentType: 'image/jpeg' },
      }),
      expect.objectContaining({ onMetrics: expect.any(Function) }),
    );
    expect(storage.saveImageAsset).toHaveBeenCalledWith(
      sheetKey,
      imageBytes('sheet-bytes'),
      'image/png',
    );
    expect(result.characterProfile.hasCharacterSheet).toBe(true);
    expect(result.characterSheetKey).toBe(sheetKey);
    expect(telemetry.snapshot().calls.map((call) => call.operation)).toEqual([
      'character_profile',
      'character_sheet',
    ]);
    expect(telemetry.snapshot().calls.map((call) => call.promptVersion)).toEqual([
      'test-profile-v1',
      'character-reference-v3',
    ]);
  });

  it('reports an integrity error and never passes mismatched photo bytes to the provider', async () => {
    const expectedPhoto = imageBytes('expected-photo');
    const storage = makeStorage();
    storage.getImageAsset.mockResolvedValue(imageBytes('tampered-photo'));
    const buildProfile = vi
      .fn()
      .mockImplementation((input) => new MockCharacterProfileProvider().buildProfile(input));
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const stage = new CharacterReferenceStage(
      storage,
      { providerName: 'mock', buildProfile },
      makeImageProvider(),
    );

    await expect(stage.execute(makeInput(expectedPhoto))).rejects.toThrow(
      'REQUIRED_REFERENCE_PHOTO_UNAVAILABLE',
    );
    expect(buildProfile).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('allows explicitly configured degraded profile fallback', async () => {
    vi.stubEnv('CHARACTER_FALLBACK_POLICY', 'allow_degraded');
    const storage = makeStorage();
    const imageProvider = makeImageProvider();
    const stage = new CharacterReferenceStage(
      storage,
      {
        providerName: 'openai',
        modelName: 'vision-model',
        buildProfile: vi.fn().mockRejectedValue(new Error('vision unavailable')),
      },
      imageProvider,
    );

    const result = await stage.execute({
      ...makeInput(),
      telemetry: new GenerationProviderTelemetry(10, 1),
    });

    vi.unstubAllEnvs();
    expect(result.providerName).toBe('mock');
    expect(result.error).toBe('Provider request failed.');
    expect(result.characterProfile.consistencyPrompt).toBeTruthy();
    expect(imageProvider.generateCharacterSheet).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation without activating profile fallback or character-sheet work', async () => {
    const storage = makeStorage();
    const imageProvider = makeImageProvider();
    const buildProfile = vi.fn().mockRejectedValue(new ProviderCancellationError());
    const stage = new CharacterReferenceStage(
      storage,
      { providerName: 'openai', buildProfile },
      imageProvider,
    );

    await expect(stage.execute(makeInput())).rejects.toBeInstanceOf(ProviderCancellationError);
    expect(buildProfile).toHaveBeenCalledOnce();
    expect(imageProvider.generateCharacterSheet).not.toHaveBeenCalled();
  });

  it('regenerates only the sheet for a reused profile and degrades truthfully on failure', async () => {
    const storage = makeStorage();
    const profileProvider = new MockCharacterProfileProvider();
    const profile = await profileProvider.buildProfile({
      bookId: 'book-1',
      childName: 'Mia',
      childAge: 7,
      theme: 'space',
      language: 'en',
    });
    const imageProvider = makeImageProvider();
    imageProvider.generateCharacterSheet.mockRejectedValue(new Error('sheet unavailable'));
    const stage = new CharacterReferenceStage(storage, profileProvider, imageProvider);

    const result = await stage.regenerateSheet({
      bookId: 'book-1',
      characterProfile: { ...profile, hasCharacterSheet: true } as CharacterProfile,
      namespace,
      telemetry: new GenerationProviderTelemetry(10, 0),
    });

    expect(result.characterProfile.hasCharacterSheet).toBe(false);
    expect(result.characterSheetKey).toBeUndefined();
    expect(result.error).toBe('Provider request failed.');
    expect(storage.saveImageAsset).not.toHaveBeenCalled();
  });

  it('loads one reusable image reference and distinguishes an unreadable recorded sheet', async () => {
    const storage = makeStorage();
    const stage = new CharacterReferenceStage(
      storage,
      new MockCharacterProfileProvider(),
      makeImageProvider(),
    );
    storage.getImageAsset.mockResolvedValueOnce(imageBytes('stored-sheet'));

    await expect(stage.loadReference('book-1', sheetKey)).resolves.toEqual({
      reference: { buffer: imageBytes('stored-sheet'), contentType: 'image/png' },
    });

    storage.getImageAsset.mockResolvedValueOnce(undefined);
    const missing = await stage.loadReference('book-1', sheetKey);
    expect(missing.reference).toBeUndefined();
    expect(missing.loadError).toContain('recorded as existing');
    expect(storage.getImageAsset).toHaveBeenCalledTimes(2);
  });

  it('enforces required personalization during sheet regeneration and late reference loss', async () => {
    const storage = makeStorage();
    const profileProvider = new MockCharacterProfileProvider();
    const profile = await profileProvider.buildProfile({
      bookId: 'book-1',
      childName: 'Mia',
      childAge: 6,
      theme: 'forest',
      language: 'en',
    });
    const images = makeImageProvider();
    const stage = new CharacterReferenceStage(storage, profileProvider, {
      ...images,
      providerName: 'openai',
    });
    images.generateCharacterSheet.mockRejectedValue(new Error('sheet unavailable'));
    await expect(
      stage.regenerateSheet({
        bookId: 'book-1',
        characterProfile: profile,
        namespace,
        telemetry: new GenerationProviderTelemetry(10, 1),
      }),
    ).rejects.toMatchObject({
      reason: 'provider_transient_failure',
      message: 'Provider request failed.',
    });
    await expect(stage.loadReference('book-1', sheetKey)).rejects.toThrow(
      'REQUIRED_CHARACTER_REFERENCE',
    );
    expect(images.generateImage).not.toHaveBeenCalled();
  });
});
