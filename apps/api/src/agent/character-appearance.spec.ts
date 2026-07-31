import { describe, expect, it } from 'vitest';
import type { CanonicalCharacterAppearance, CharacterProfile } from '@book/types';
import {
  characterFingerprint,
  finalizeCharacterProfile,
  isCharacterFingerprintCompatible,
} from './character-appearance';

const appearance: CanonicalCharacterAppearance = {
  age: 6,
  hair: 'short wavy brown hair',
  eyes: 'bright green eyes',
  face: 'round friendly face',
  clothing: 'yellow overalls',
  artStyle: 'soft watercolor',
};

const baseProfile: CharacterProfile = {
  childName: 'Mia',
  age: 6,
  visualDescription: 'A cheerful child',
  faceDescription: appearance.face,
  hairDescription: appearance.hair,
  outfitDescription: appearance.clothing,
  personalitySummary: 'curious and kind',
  illustrationStyle: appearance.artStyle,
  consistencyPrompt: 'legacy fragment',
  hasReferencePhoto: true,
  hasCharacterSheet: false,
};

describe('canonical character appearance', () => {
  it('produces the same fingerprint for the same canonical input', () => {
    expect(characterFingerprint(appearance, 'photo-r1')).toBe(
      characterFingerprint(appearance, 'photo-r1'),
    );
  });

  it('does not depend on object field insertion order', () => {
    const reordered = {
      artStyle: appearance.artStyle,
      clothing: appearance.clothing,
      face: appearance.face,
      eyes: appearance.eyes,
      hair: appearance.hair,
      age: appearance.age,
    };

    expect(characterFingerprint(reordered, 'photo-r1')).toBe(
      characterFingerprint(appearance, 'photo-r1'),
    );
  });

  it('changes for a meaningful appearance or reference revision', () => {
    expect(characterFingerprint({ ...appearance, hair: 'long black hair' }, 'photo-r1')).not.toBe(
      characterFingerprint(appearance, 'photo-r1'),
    );
    expect(characterFingerprint(appearance, 'photo-r2')).not.toBe(
      characterFingerprint(appearance, 'photo-r1'),
    );
  });

  it('locks age, hair, eyes, face, clothing, and art style in stable order', () => {
    const profile = finalizeCharacterProfile(baseProfile, {
      eyeDescription: appearance.eyes,
      referenceAssetRevision: 'photo-r1',
    });

    expect(profile.schemaVersion).toBe(1);
    expect(profile.lockedVisualDescription).toBe(
      'LOCKED CHARACTER: Mia; age 6; hair: short wavy brown hair; eyes: bright green eyes; face: round friendly face; clothing: yellow overalls; art style: soft watercolor',
    );
    expect(isCharacterFingerprintCompatible(profile, 'photo-r1')).toBe(true);
    expect(isCharacterFingerprintCompatible(profile, 'photo-r2')).toBe(false);
  });
});
