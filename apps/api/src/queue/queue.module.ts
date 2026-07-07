import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { QUEUES } from './queues.config';

const ALL_QUEUES = Object.values(QUEUES).map((name) => ({ name }));

/**
 * Default retry configuration for all agent queues:
 * - 3 attempts total
 * - Exponential backoff starting at 2 000 ms (2s, 4s, 8s)
 */
const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 2_000,
  },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 5_000 },
};

/** Global so any feature module can @InjectQueue(...) without importing this module directly — mirrors CacheModule. */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        return {
          // BullMQ forwards `url` straight to `new Redis(url, rest)`, so ioredis's own
          // parser handles rediss:// TLS, username, password, and db-in-path — unlike
          // manually picking apart the URL, which silently drops all of those.
          connection: {
            url: config.get('REDIS_URL'),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
          },
          defaultJobOptions: DEFAULT_JOB_OPTIONS,
        };
      },
    }),
    BullModule.registerQueue(...ALL_QUEUES),
  ],
  exports: [BullModule],
})
export class QueueModule {}
