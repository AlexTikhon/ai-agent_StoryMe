import type { CharacterProfile } from '@book/types';

export interface CharacterProfileInput {
  bookId: string;
  childName: string;
  childAge: number;
  theme: string;
  language: string;
  /**
   * Base64-encoded bytes of the child's uploaded reference photo, if any.
   * The only place this ever travels is into a vision-capable text model
   * (OpenAICharacterProfileProvider) to *describe* the child in words — it
   * is never sent to an image-generation/edit call, and never stored beyond
   * this one request.
   */
  photo?: { base64: string; contentType: string } | undefined;
}

/**
 * Internal boundary for turning a child's name/age/theme (and, optionally, a
 * reference photo) into a stylized, non-identifying CharacterProfile.
 * AgentService depends on this interface rather than building the profile
 * inline, mirroring StoryGenerationProvider/ImageGenerationProvider — a
 * future real-vision provider implements it without touching AgentService or
 * anything downstream (story/image prompt building).
 */
export interface CharacterProfileProvider {
  /** 'mock' | 'openai' — surfaced only for generation diagnostics, never used for control flow. */
  readonly providerName?: string;
  /** Underlying model identifier, if applicable (mock providers have none). */
  readonly modelName?: string;
  buildProfile(input: CharacterProfileInput): Promise<CharacterProfile>;
}

export const CHARACTER_PROFILE_PROVIDER_TOKEN = 'CHARACTER_PROFILE_PROVIDER';

const ILLUSTRATION_STYLE =
  'warm children book illustration, soft colors, friendly character design';

/**
 * Builds the single consistency-prompt fragment folded into every page/
 * cover/back-cover illustration prompt (see story-generation-provider.ts and
 * openai-story-generation-provider.ts). Shared by both providers so the
 * fragment's shape stays identical regardless of which one built the rest of
 * the profile.
 */
export function buildConsistencyPrompt(
  profile: Pick<
    CharacterProfile,
    'childName' | 'age' | 'faceDescription' | 'hairDescription' | 'outfitDescription'
  >,
): string {
  return `${profile.childName}, a stylized ${profile.age}-year-old children's-book character with ${profile.faceDescription}, ${profile.hairDescription}, wearing ${profile.outfitDescription}`;
}

/**
 * Deterministic local stand-in for a future real-vision CharacterProfileProvider.
 * Never analyzes photo bytes (mocks never touch real bytes/AI, matching
 * MockStoryGenerationProvider/MockImageGenerationProvider) — produces the
 * same generic, warm, child-safe descriptors from childName/childAge alone,
 * only recording whether a photo was supplied.
 */
export class MockCharacterProfileProvider implements CharacterProfileProvider {
  readonly providerName = 'mock' as const;

  async buildProfile(input: CharacterProfileInput): Promise<CharacterProfile> {
    const { childName, childAge } = input;
    const faceDescription = 'a round, friendly face with a warm smile';
    const hairDescription = 'short wavy brown hair';
    const outfitDescription = 'a bright yellow overall with sneakers';

    const profile: CharacterProfile = {
      childName,
      age: childAge,
      visualDescription: `${childName} is a cheerful ${childAge}-year-old with ${faceDescription} and ${hairDescription}`,
      faceDescription,
      hairDescription,
      outfitDescription,
      personalitySummary: 'curious, brave, and kind',
      illustrationStyle: ILLUSTRATION_STYLE,
      consistencyPrompt: '',
      hasReferencePhoto: input.photo != null,
      hasCharacterSheet: false,
    };
    profile.consistencyPrompt = buildConsistencyPrompt(profile);
    return profile;
  }
}
