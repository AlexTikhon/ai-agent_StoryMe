import { createHash } from 'node:crypto';
import { PROMPT_VERSIONS } from './prompt-versions';
import { PROMPT_COMPATIBILITY_IDENTITY } from './prompt-specs';

type PromptVersions = { readonly [K in keyof typeof PROMPT_VERSIONS]: string };

export interface GenerationProviderIdentity {
  readonly providerName?: string;
  readonly modelName?: string;
  readonly promptVersion?: string;
  readonly pageImagePromptVersion?: string;
  readonly repairPromptVersion?: string;
}

export interface GenerationPipelineProviders {
  readonly story: GenerationProviderIdentity;
  readonly image: GenerationProviderIdentity;
  readonly character: GenerationProviderIdentity;
}

/**
 * One conservative compatibility boundary for the complete AI pipeline.
 * Any prompt, provider, or model change intentionally invalidates reuse of
 * every persisted generation artifact.
 */
export function buildGenerationCompatibilityFingerprint(
  providers: GenerationPipelineProviders,
  promptVersions: PromptVersions = PROMPT_VERSIONS,
): string {
  const compatibility = {
    version: 3,
    prompts: promptVersions,
    promptContracts: PROMPT_COMPATIBILITY_IDENTITY,
    providers: {
      character: {
        prompt: providers.character.promptVersion ?? promptVersions.characterProfile,
        provider: providers.character.providerName ?? null,
        model: providers.character.modelName ?? null,
      },
      image: {
        prompt: providers.image.promptVersion ?? promptVersions.characterReference,
        pagePrompt: providers.image.pageImagePromptVersion ?? promptVersions.pageImage,
        provider: providers.image.providerName ?? null,
        model: providers.image.modelName ?? null,
      },
      story: {
        prompt: providers.story.promptVersion ?? promptVersions.story,
        repairPrompt: providers.story.repairPromptVersion ?? promptVersions.storyRepair,
        provider: providers.story.providerName ?? null,
        model: providers.story.modelName ?? null,
      },
    },
  };

  return createHash('sha256').update(JSON.stringify(compatibility)).digest('hex');
}
