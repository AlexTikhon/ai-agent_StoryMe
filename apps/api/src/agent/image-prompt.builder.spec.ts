import { describe, expect, it } from 'vitest';
import { MockCharacterProfileProvider } from './character-profile-provider';
import { buildCharacterSheetPrompt } from '../images/openai-image-generation-provider';
import { createCharacterVisualBible } from './character-visual-bible';
import { buildBookImagePrompt } from './image-prompt.builder';
import { PROMPT_VERSIONS } from './prompt-versions';

async function bible() {
  const profile = await new MockCharacterProfileProvider().buildProfile({
    bookId: 'prompt-book',
    childName: 'Mia',
    childAge: 6,
    theme: 'space',
    language: 'en',
  });
  return { profile, bible: createCharacterVisualBible(profile) };
}

describe('canonical visual prompt flow', () => {
  it('uses the same immutable visual bible in the reference and page prompts', async () => {
    const value = await bible();
    const page = buildBookImagePrompt({
      bible: value.bible,
      scene: { kind: 'page', theme: 'space', summary: 'Mia opens the observatory door' },
    });
    const reference = buildCharacterSheetPrompt(value.profile);

    expect(Object.isFrozen(value.bible)).toBe(true);
    expect(page).toContain(value.bible.fingerprint);
    expect(reference).toContain(value.bible.fingerprint);
    expect(page).toContain(value.bible.protagonistName);
    expect(reference).toContain(value.bible.protagonistName);
  });

  it('keeps stable identity equal while page-specific scenes differ', async () => {
    const value = await bible();
    const first = buildBookImagePrompt({
      bible: value.bible,
      scene: { kind: 'page', theme: 'space', summary: 'Mia studies a moon map' },
    });
    const second = buildBookImagePrompt({
      bible: value.bible,
      scene: { kind: 'page', theme: 'space', summary: 'Mia repairs a tiny rover' },
    });
    const stable = (prompt: string) => prompt.split('[END STABLE CHARACTER IDENTITY]')[0];

    expect(stable(first)).toBe(stable(second));
    expect(first).toContain('moon map');
    expect(second).toContain('tiny rover');
    expect(first).not.toBe(second);
  });

  it('has explicit prompt versions and never serializes unresolved values', async () => {
    const value = await bible();
    const prompt = buildBookImagePrompt({
      bible: value.bible,
      scene: { kind: 'cover', theme: 'animals', summary: 'Mia greets a rabbit' },
    });

    expect(PROMPT_VERSIONS).toEqual({
      characterProfile: 'character-profile-v2',
      story: 'story-v3',
      storyRepair: 'story-repair-v2',
      characterReference: 'character-reference-v3',
      pageImage: 'page-image-v3',
    });
    expect(prompt).not.toMatch(/undefined|\[object Object\]|raw secret/iu);
  });
});
