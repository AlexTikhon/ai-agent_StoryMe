import { MockFailureController } from '../config/mock-failure';
import {
  resolveTargetPageCount,
  type StoryGenerationInput,
  type StoryGenerationProvider,
  type StoryGenerationResult,
} from './story-generation-contracts';
import {
  buildBookPreview,
  buildIllustrationPlan,
  buildImageGenerationResult,
  buildPagePlan,
  buildStoryDraft,
  buildStoryPlan,
} from './mock-story-builders';
import { resolveTemplateLanguage } from './mock-story-templates';
import { createCharacterCard } from './character-card.factory';
import { PROMPT_VERSIONS } from './prompt-versions';
import type { ProviderExecutionOptions } from '../common/provider-execution';

/**
 * Deterministic local stand-in for a future real-LLM StoryGenerationProvider.
 * Produces the same hand-written template output AgentService generated
 * inline before this boundary existed — same inputs always produce the same
 * character/story/page/image-metadata output, no I/O, no randomness beyond
 * hashing the book's own fields.
 */
export class MockStoryGenerationProvider implements StoryGenerationProvider {
  readonly promptVersion = PROMPT_VERSIONS.story;
  readonly providerName = 'mock' as const;

  constructor(private readonly failures?: MockFailureController) {}

  async generateStory(
    input: StoryGenerationInput,
    options: ProviderExecutionOptions = {},
  ): Promise<StoryGenerationResult> {
    await options.beforeDispatch?.();
    await this.failures?.before('story');
    const { bookId, childName, childAge, theme, language, educationalMessage, characterProfile } =
      input;
    const pageCount = resolveTargetPageCount(input.pageCount);
    const lang = resolveTemplateLanguage(language);

    const characterCard = createCharacterCard(characterProfile);
    const storyPlan = buildStoryPlan(childName, theme, pageCount, lang, educationalMessage);
    const pages = buildPagePlan(storyPlan, pageCount, lang);
    const storyPlanWithDraft = buildStoryDraft(characterCard, { ...storyPlan, pages }, lang);
    const storyPlanFinal = buildIllustrationPlan(
      characterCard,
      characterProfile,
      storyPlanWithDraft,
    );
    const bookPreview = buildBookPreview(
      { childName, childAge, language },
      characterCard,
      characterProfile,
      storyPlanFinal,
    );
    const imageGenerationResult = buildImageGenerationResult(bookId, bookPreview, characterProfile);

    return { characterCard, storyPlan: storyPlanFinal, bookPreview, imageGenerationResult };
  }
}
