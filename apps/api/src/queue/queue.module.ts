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
        const redisUrl = config.get('REDIS_URL');
        const url = new URL(redisUrl);
        return {
          connection: {
            host: url.hostname,
            port: Number(url.port) || 6379,
            password: url.password || undefined,
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
