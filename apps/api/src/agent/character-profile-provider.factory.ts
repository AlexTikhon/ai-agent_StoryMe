import { Logger } from '@nestjs/common';
import {
  MockCharacterProfileProvider,
  type CharacterProfileProvider,
} from './character-profile-provider';
import { OpenAICharacterProfileProvider } from './openai-character-profile-provider';
import { readOpenAIRetryConfig } from '../common/openai-request';

export type CharacterProfileProviderName = 'mock' | 'openai';

const logger = new Logger('CharacterProfileProviderFactory');

/**
 * Selects the CharacterProfileProvider implementation from env. Defaults to
 * mock so local dev, tests, and CI never depend on a real API key unless
 * CHARACTER_PROFILE_PROVIDER=openai is explicitly set — independent of
 * STORY_GENERATION_PROVIDER/IMAGE_GENERATION_PROVIDER, matching how those two
 * pipeline stages are already independently switchable. Takes an explicit
 * env map (defaulting to process.env) so provider selection is unit-testable
 * without mutating global state.
 */
export function createCharacterProfileProvider(
  env: NodeJS.ProcessEnv = process.env,
): CharacterProfileProvider {
  const raw = env['CHARACTER_PROFILE_PROVIDER']?.trim().toLowerCase();

  if (!raw || raw === 'mock') {
    logger.log('Character profile provider selected: mock');
    return new MockCharacterProfileProvider();
  }

  if (raw !== 'openai') {
    throw new Error(`Unknown CHARACTER_PROFILE_PROVIDER "${raw}" (expected "mock" or "openai")`);
  }

  const apiKey = env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new Error('CHARACTER_PROFILE_PROVIDER=openai requires OPENAI_API_KEY to be set');
  }

  const model = env['OPENAI_CHARACTER_PROFILE_MODEL'];
  const { timeoutMs, maxRetries } = readOpenAIRetryConfig(env);
  logger.log(
    `Character profile provider selected: openai model=${model ?? '(default)'} timeoutMs=${timeoutMs} maxRetries=${maxRetries}`,
  );

  return new OpenAICharacterProfileProvider({
    apiKey,
    ...(model && { model }),
    timeoutMs,
    maxRetries,
  });
}
