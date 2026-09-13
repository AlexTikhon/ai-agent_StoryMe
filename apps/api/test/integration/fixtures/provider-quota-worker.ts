import '../setup';
import Redis from 'ioredis';
import { RedisProviderQuotaGate } from '../../../src/images/provider-quota-gate';
import { OpenAIImageRateLimiter } from '../../../src/images/openai-image-rate-limiter';
import { OpenAIImageGenerationProvider } from '../../../src/images/openai-image-generation-provider';

async function main() {
  const [scope, providerUrl] = process.argv.slice(2);
  if (!scope || !providerUrl) throw new Error('Quota scope and fake provider URL are required');
  const redis = new Redis(process.env['REDIS_URL']!);
  try {
    const rateLimiter = new OpenAIImageRateLimiter({
      minIntervalMs: 200,
      maxRetries: 0,
      maxWaitMs: 5_000,
      maxConcurrency: 1,
      concurrencyLeaseMs: 1_000,
      sharedGate: new RedisProviderQuotaGate(redis),
      quotaScope: scope,
    });
    const provider = new OpenAIImageGenerationProvider({
      apiKey: 'synthetic-test-key',
      baseUrl: providerUrl,
      timeoutMs: 750,
      maxRetries: 0,
      timeoutMaxRetries: 0,
      rateLimiter,
    });
    await provider.generateImage({
      bookId: 'synthetic-book',
      entry: {
        id: 'synthetic-cover',
        kind: 'cover',
        prompt: 'synthetic child-safe scene',
        provider: 'openai',
        status: 'pending',
        imageUrl: null,
        altText: 'Synthetic cover',
        width: 1024,
        height: 1024,
        seed: 'synthetic-seed',
      },
      characterCard: {} as never,
    });
  } finally {
    await redis.quit();
  }
}

void main().then(
  () => process.exit(0),
  () => process.exit(1),
);
