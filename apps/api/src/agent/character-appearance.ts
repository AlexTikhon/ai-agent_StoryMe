import { createHash } from 'node:crypto';
import type { CanonicalCharacterAppearance, CharacterProfile } from '@book/types';

export const CHARACTER_PROFILE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_EYE_DESCRIPTION = 'bright, expressive eyes';
export const CHARACTER_NEGATIVE_CONSTRAINTS = [
  'age changes',
  'different hairstyle or hair color',
  'different eye appearance',
  'different face shape',
  'different clothing',
  'photorealistic identity matching',
] as const;

function normalizeTrait(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function canonicalizeCharacterAppearance(
  appearance: CanonicalCharacterAppearance,
): CanonicalCharacterAppearance {
  return {
    age: appearance.age,
    hair: normalizeTrait(appearance.hair),
    eyes: normalizeTrait(appearance.eyes),
    face: normalizeTrait(appearance.face),
    clothing: normalizeTrait(appearance.clothing),
    artStyle: normalizeTrait(appearance.artStyle),
  };
}

export function characterFingerprint(
  appearance: CanonicalCharacterAppearance,
  referenceAssetRevision: string | null = null,
): string {
  const canonical = canonicalizeCharacterAppearance(appearance);
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: CHARACTER_PROFILE_SCHEMA_VERSION,
        appearance: canonical,
        referenceAssetRevision,
      }),
    )
    .digest('hex');
}

export function lockedVisualDescription(
  childName: string,
  appearance: CanonicalCharacterAppearance,
): string {
  const canonical = canonicalizeCharacterAppearance(appearance);
  return [
    `LOCKED CHARACTER: ${childName}`,
    `age ${canonical.age}`,
    `hair: ${canonical.hair}`,
    `eyes: ${canonical.eyes}`,
    `face: ${canonical.face}`,
    `clothing: ${canonical.clothing}`,
    `art style: ${canonical.artStyle}`,
  ].join('; ');
}

export function finalizeCharacterProfile(
  profile: CharacterProfile,
  options: {
    eyeDescription?: string;
    referenceAssetRevision?: string | null;
  } = {},
): CharacterProfile {
  const canonicalAppearance = canonicalizeCharacterAppearance({
    age: profile.age,
    hair: profile.hairDescription,
    eyes: options.eyeDescription ?? DEFAULT_EYE_DESCRIPTION,
    face: profile.faceDescription,
    clothing: profile.outfitDescription,
    artStyle: profile.illustrationStyle,
  });
  return {
    ...profile,
    schemaVersion: CHARACTER_PROFILE_SCHEMA_VERSION,
    canonicalAppearance,
    characterFingerprint: characterFingerprint(
      canonicalAppearance,
      options.referenceAssetRevision ?? null,
    ),
    lockedVisualDescription: lockedVisualDescription(profile.childName, canonicalAppearance),
    negativeConstraints: [...CHARACTER_NEGATIVE_CONSTRAINTS],
  };
}

export function isCharacterFingerprintCompatible(
  profile: CharacterProfile,
  referenceAssetRevision: string | null,
): boolean {
  return (
    profile.canonicalAppearance !== undefined &&
    profile.characterFingerprint !== undefined &&
    profile.characterFingerprint ===
      characterFingerprint(profile.canonicalAppearance, referenceAssetRevision)
  );
}
