import { describe, it, expect } from 'vitest';
import {
  buildConsistencyPrompt,
  MockCharacterProfileProvider,
  type CharacterProfileInput,
} from './character-profile-provider';

function makeInput(overrides: Partial<CharacterProfileInput> = {}): CharacterProfileInput {
  return {
    bookId: 'b-1',
    childName: 'Mia',
    childAge: 5,
    theme: 'friendship',
    language: 'en',
    ...overrides,
  };
}

describe('MockCharacterProfileProvider', () => {
  it('returns the same output for the same input (deterministic)', async () => {
    const provider = new MockCharacterProfileProvider();
    const input = makeInput();

    const first = await provider.buildProfile(input);
    const second = await provider.buildProfile(input);

    expect(second).toEqual(first);
  });

  it('never analyzes photo bytes — output does not depend on photo content', async () => {
    const provider = new MockCharacterProfileProvider();

    const withoutPhoto = await provider.buildProfile(makeInput());
    const withPhoto = await provider.buildProfile(
      makeInput({ photo: { base64: 'ZmFrZS1ieXRlcw==', contentType: 'image/jpeg' } }),
    );

    expect(withPhoto.faceDescription).toBe(withoutPhoto.faceDescription);
    expect(withPhoto.hairDescription).toBe(withoutPhoto.hairDescription);
    expect(withPhoto.outfitDescription).toBe(withoutPhoto.outfitDescription);
  });

  it('sets hasReferencePhoto based on whether a photo was supplied', async () => {
    const provider = new MockCharacterProfileProvider();

    const withoutPhoto = await provider.buildProfile(makeInput());
    const withPhoto = await provider.buildProfile(
      makeInput({ photo: { base64: 'ZmFrZS1ieXRlcw==', contentType: 'image/jpeg' } }),
    );

    expect(withoutPhoto.hasReferencePhoto).toBe(false);
    expect(withPhoto.hasReferencePhoto).toBe(true);
  });

  it('always starts with hasCharacterSheet false (the agent sets it after the sheet step)', async () => {
    const provider = new MockCharacterProfileProvider();
    const profile = await provider.buildProfile(makeInput());
    expect(profile.hasCharacterSheet).toBe(false);
  });

  it('includes childName and age in the profile and consistencyPrompt', async () => {
    const provider = new MockCharacterProfileProvider();
    const profile = await provider.buildProfile(makeInput({ childName: 'Leo', childAge: 7 }));

    expect(profile.childName).toBe('Leo');
    expect(profile.age).toBe(7);
    expect(profile.consistencyPrompt).toContain('Leo');
    expect(profile.consistencyPrompt).toContain('7');
  });

  it('produces a non-empty consistencyPrompt built from face/hair/outfit descriptions', async () => {
    const provider = new MockCharacterProfileProvider();
    const profile = await provider.buildProfile(makeInput());

    expect(profile.consistencyPrompt.length).toBeGreaterThan(0);
    expect(profile.consistencyPrompt).toContain(profile.faceDescription);
    expect(profile.consistencyPrompt).toContain(profile.hairDescription);
    expect(profile.consistencyPrompt).toContain(profile.outfitDescription);
  });
});

describe('buildConsistencyPrompt', () => {
  it('includes name, age, face, hair, and outfit', () => {
    const prompt = buildConsistencyPrompt({
      childName: 'Ana',
      age: 6,
      faceDescription: 'a round face',
      hairDescription: 'curly red hair',
      outfitDescription: 'a green dress',
    });

    expect(prompt).toContain('Ana');
    expect(prompt).toContain('6');
    expect(prompt).toContain('a round face');
    expect(prompt).toContain('curly red hair');
    expect(prompt).toContain('a green dress');
  });
});
