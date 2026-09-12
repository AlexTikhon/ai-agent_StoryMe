import '../setup';
import Redis from 'ioredis';
import { RedisProviderQuotaGate } from '../../../src/images/provider-quota-gate';

async function main() {
  const [scope, providerUrl] = process.argv.slice(2);
  if (!scope || !providerUrl) throw new Error('Quota scope and fake provider URL are required');
  const redis = new Redis(process.env['REDIS_URL']!);
  try {
    const permit = await new RedisProviderQuotaGate(redis).acquire(scope, 200, 5_000, 1, 400);
    try {
      const response = await fetch(providerUrl, {
        method: 'POST',
        body: 'synthetic-image-request',
      });
      if (!response.ok) throw new Error(`Fake provider returned HTTP ${response.status}`);
    } finally {
      await permit.release();
    }
  } finally {
    await redis.quit();
  }
}

void main().then(
  () => process.exit(0),
  () => process.exit(1),
);
