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
    generateImage: vi.fn(),
    generateCharacterSheet: vi.fn().mockResolvedValue({
      buffer: Buffer.from('sheet-bytes'),
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
    const photo = Buffer.from('verified-photo');
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
    );
    expect(storage.saveImageAsset).toHaveBeenCalledWith(
      sheetKey,
      Buffer.from('sheet-bytes'),
      'image/png',
    );
    expect(result.characterProfile.hasCharacterSheet).toBe(true);
    expect(result.characterSheetKey).toBe(sheetKey);
    expect(telemetry.snapshot().calls.map((call) => call.operation)).toEqual([
      'character_profile',
      'character_sheet',
    ]);
  });

  it('reports an integrity error and never passes mismatched photo bytes to the provider', async () => {
    const expectedPhoto = Buffer.from('expected-photo');
    const storage = makeStorage();
    storage.getImageAsset.mockResolvedValue(Buffer.from('tampered-photo'));
    const buildProfile = vi
      .fn()
      .mockImplementation((input) => new MockCharacterProfileProvider().buildProfile(input));
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const stage = new CharacterReferenceStage(
      storage,
      { providerName: 'mock', buildProfile },
      makeImageProvider(),
    );

    const result = await stage.execute(makeInput(expectedPhoto));

    expect(buildProfile).toHaveBeenCalledWith(expect.objectContaining({ photo: undefined }));
    expect(result.error).toContain('CHILD_PHOTO_INTEGRITY_MISMATCH');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('CHILD_PHOTO_INTEGRITY_MISMATCH'),
    );
  });

  it('falls back to a generic profile without aborting sheet generation', async () => {
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

    expect(result.providerName).toBe('mock');
    expect(result.error).toBe('vision unavailable');
    expect(result.characterProfile.consistencyPrompt).toBeTruthy();
    expect(imageProvider.generateCharacterSheet).toHaveBeenCalledTimes(1);
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
    expect(result.error).toBe('sheet unavailable');
    expect(storage.saveImageAsset).not.toHaveBeenCalled();
  });

  it('loads one reusable image reference and distinguishes an unreadable recorded sheet', async () => {
    const storage = makeStorage();
    const stage = new CharacterReferenceStage(
      storage,
      new MockCharacterProfileProvider(),
      makeImageProvider(),
    );
    storage.getImageAsset.mockResolvedValueOnce(Buffer.from('stored-sheet'));

    await expect(stage.loadReference('book-1', sheetKey)).resolves.toEqual({
      reference: { buffer: Buffer.from('stored-sheet'), contentType: 'image/png' },
    });

    storage.getImageAsset.mockResolvedValueOnce(undefined);
    const missing = await stage.loadReference('book-1', sheetKey);
    expect(missing.reference).toBeUndefined();
    expect(missing.loadError).toContain('recorded as existing');
    expect(storage.getImageAsset).toHaveBeenCalledTimes(2);
  });
});
