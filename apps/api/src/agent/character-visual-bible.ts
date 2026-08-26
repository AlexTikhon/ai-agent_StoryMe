import type { CharacterProfile, CharacterVisualBible } from '@book/types';
import { createHash } from 'node:crypto';

const IDENTITY_RULES = [
  'Keep the same approximate age, face, hairstyle, hair color, and eye appearance.',
  'Keep one protagonist with the same body proportions and visual style.',
  'Do not replace the protagonist with another child or add a duplicate protagonist.',
] as const;

const SCENE_FLEXIBILITY_RULES = [
  'Pose, action, expression, lighting, and setting should follow the current scene.',
  'Keep the default wardrobe unless the current story scene explicitly requires a clothing change.',
] as const;

function clean(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function freezeBible(bible: CharacterVisualBible): CharacterVisualBible {
  Object.freeze(bible.appearance);
  Object.freeze(bible.identityRules);
  Object.freeze(bible.sceneFlexibilityRules);
  return Object.freeze(bible);
}

/** Builds only from legitimately known profile fields; it never infers traits. */
export function createCharacterVisualBible(profile: CharacterProfile): CharacterVisualBible {
  const appearance = profile.canonicalAppearance ?? {
    age: profile.age,
    hair: profile.hairDescription,
    eyes: 'bright, expressive eyes',
    face: profile.faceDescription,
    clothing: profile.outfitDescription,
    artStyle: profile.illustrationStyle,
  };
  const fingerprint =
    profile.characterFingerprint ??
    createHash('sha256')
      .update(JSON.stringify({ schemaVersion: 1, appearance, referenceAssetRevision: null }))
      .digest('hex');
  return freezeBible({
    schemaVersion: 1,
    protagonistName: clean(profile.childName),
    approximateAge: appearance.age,
    appearance: {
      hair: clean(appearance.hair),
      eyes: clean(appearance.eyes),
      face: clean(appearance.face),
    },
    defaultWardrobe: clean(appearance.clothing),
    visualStyle: clean(appearance.artStyle),
    identityRules: [...IDENTITY_RULES],
    sceneFlexibilityRules: [...SCENE_FLEXIBILITY_RULES],
    fingerprint,
  });
}

export function resolveCharacterVisualBible(profile: CharacterProfile): CharacterVisualBible {
  return profile.visualBible &&
    profile.visualBible.protagonistName === profile.childName &&
    profile.visualBible.approximateAge === profile.age &&
    profile.visualBible.fingerprint === profile.characterFingerprint
    ? freezeBible(structuredClone(profile.visualBible))
    : createCharacterVisualBible(profile);
}

export function buildVisualIdentityBlock(bible: CharacterVisualBible): string {
  return [
    `CHARACTER VISUAL BIBLE v${bible.schemaVersion}`,
    `LOCKED CHARACTER: ${bible.protagonistName}; age ${bible.approximateAge}; hair: ${bible.appearance.hair}; eyes: ${bible.appearance.eyes}; face: ${bible.appearance.face}; clothing: ${bible.defaultWardrobe}; art style: ${bible.visualStyle}`,
    `Identity rules: ${bible.identityRules.join(' ')}`,
    `Scene flexibility: ${bible.sceneFlexibilityRules.join(' ')}`,
    `Identity fingerprint: ${bible.fingerprint}`,
  ].join('\n');
}
