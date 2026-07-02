import { Logger } from '@nestjs/common';
import {
  MockStoryGenerationProvider,
  type StoryGenerationProvider,
} from './story-generation-provider';
import { OpenAIStoryGenerationProvider } from './openai-story-generation-provider';
import { readOpenAIRetryConfig } from '../common/openai-request';

export type StoryGenerationProviderName = 'mock' | 'openai';

const logger = new Logger('StoryGenerationProviderFactory');

/**
 * Selects the StoryGenerationProvider implementation from env. Defaults to
 * mock so local dev, tests, and CI never depend on a real API key unless
 * STORY_GENERATION_PROVIDER=openai is explicitly set. Takes an explicit env
 * map (defaulting to process.env) so provider selection is unit-testable
 * without mutating global state.
 */
export function createStoryGenerationProvider(
  env: NodeJS.ProcessEnv = process.env,
): StoryGenerationProvider {
  const raw = env['STORY_GENERATION_PROVIDER']?.trim().toLowerCase();

  if (!raw || raw === 'mock') {
    logger.log('Story generation provider selected: mock');
    return new MockStoryGenerationProvider();
  }

  if (raw !== 'openai') {
    throw new Error(`Unknown STORY_GENERATION_PROVIDER "${raw}" (expected "mock" or "openai")`);
  }

  const apiKey = env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new Error('STORY_GENERATION_PROVIDER=openai requires OPENAI_API_KEY to be set');
  }

  const model = env['OPENAI_MODEL'];
  const { timeoutMs, maxRetries } = readOpenAIRetryConfig(env);
  logger.log(
    `Story generation provider selected: openai model=${model ?? '(default)'} timeoutMs=${timeoutMs} maxRetries=${maxRetries}`,
  );

  return new OpenAIStoryGenerationProvider({
    apiKey,
    ...(model && { model }),
    timeoutMs,
    maxRetries,
  });
}
