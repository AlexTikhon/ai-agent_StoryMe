import { Logger } from '@nestjs/common';
import {
  MockImageGenerationProvider,
  type ImageGenerationProvider,
} from './image-generation-provider';
import { OpenAIImageGenerationProvider } from './openai-image-generation-provider';
import { readOpenAIImageTimeoutConfig, readOpenAIRetryConfig } from '../common/openai-request';
import {
  OpenAIImageRateLimiter,
  readOpenAIImageRateLimiterConfig,
} from './openai-image-rate-limiter';

export type ImageGenerationProviderName = 'mock' | 'openai';

const DEFAULT_MAX_PAGES = 12;

const logger = new Logger('ImageGenerationProviderFactory');

function readMaxPages(env: NodeJS.ProcessEnv): number {
  const raw = env['REAL_GENERATION_MAX_PAGES'];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_PAGES;
}

/**
 * Selects the ImageGenerationProvider implementation from env. Defaults to
 * mock so local dev, tests, and CI never depend on a real API key unless
 * IMAGE_GENERATION_PROVIDER=openai is explicitly set. Takes an
 * explicit env map (defaulting to process.env) so provider selection is
 * unit-testable without mutating global state.
 */
export function createImageGenerationProvider(
  env: NodeJS.ProcessEnv = process.env,
): ImageGenerationProvider {
  const raw = env['IMAGE_GENERATION_PROVIDER']?.trim().toLowerCase();

  if (!raw || raw === 'mock') {
    logger.log('Image generation provider selected: mock');
    return new MockImageGenerationProvider();
  }

  if (raw !== 'openai') {
    throw new Error(`Unknown IMAGE_GENERATION_PROVIDER "${raw}" (expected "mock" or "openai")`);
  }

  const apiKey = env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new Error('IMAGE_GENERATION_PROVIDER=openai requires OPENAI_API_KEY to be set');
  }

  const model = env['OPENAI_IMAGE_MODEL'];
  // Network/5xx retries (maxRetries) still come from the shared
  // OPENAI_MAX_RETRIES config; timeoutMs/timeoutMaxRetries come from their
  // own image-specific env vars (OPENAI_IMAGE_REQUEST_TIMEOUT_MS /
  // OPENAI_IMAGE_TIMEOUT_MAX_RETRIES) — see readOpenAIImageTimeoutConfig.
  const { maxRetries } = readOpenAIRetryConfig(env);
  const { timeoutMs, timeoutMaxRetries } = readOpenAIImageTimeoutConfig(env);
  const maxPages = readMaxPages(env);
  const rateLimiterConfig = readOpenAIImageRateLimiterConfig(env);
  // One limiter instance shared by every call this provider makes (character
  // sheet, cover, pages, back cover) — see OpenAIImageRateLimiter's class doc.
  const rateLimiter = new OpenAIImageRateLimiter(rateLimiterConfig);
  logger.log(
    `Image generation provider selected: openai model=${model ?? '(default)'} timeoutMs=${timeoutMs} maxRetries=${maxRetries} timeoutMaxRetries=${timeoutMaxRetries} maxPages=${maxPages} ` +
      `imageMinIntervalMs=${rateLimiterConfig.minIntervalMs} imageMaxRetries=${rateLimiterConfig.maxRetries} imageRetryBaseMs=${rateLimiterConfig.retryBaseMs} imageRetryMaxMs=${rateLimiterConfig.retryMaxMs}`,
  );

  return new OpenAIImageGenerationProvider({
    apiKey,
    ...(model && { model }),
    timeoutMs,
    maxRetries,
    timeoutMaxRetries,
    maxPages,
    rateLimiter,
  });
}
