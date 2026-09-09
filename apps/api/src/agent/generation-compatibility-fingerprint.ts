import { createHash } from 'node:crypto';
import { PROMPT_VERSIONS } from './prompt-versions';

type PromptVersions = { readonly [K in keyof typeof PROMPT_VERSIONS]: string };

export interface GenerationProviderIdentity {
  readonly providerName?: string;
  readonly modelName?: string;
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
    version: 1,
    prompts: promptVersions,
    providers: {
      character: {
        provider: providers.character.providerName ?? null,
        model: providers.character.modelName ?? null,
      },
      image: {
        provider: providers.image.providerName ?? null,
        model: providers.image.modelName ?? null,
      },
      story: {
        provider: providers.story.providerName ?? null,
        model: providers.story.modelName ?? null,
      },
    },
  };

  return createHash('sha256').update(JSON.stringify(compatibility)).digest('hex');
}
