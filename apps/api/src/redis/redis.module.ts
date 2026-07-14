import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { Env } from '../config/env.schema';

export const REDIS_CLIENT_TOKEN = 'REDIS_CLIENT';

/**
 * Single shared ioredis connection built from REDIS_URL — the same
 * connection string BullMQ already requires (see queue.module.ts), so this
 * adds no new required config. Kept separate from BullMQ's own Queue/Worker
 * connections since those are owned by bullmq's internals; this one is for
 * plain Redis commands (rate limiting, future locks/circuit-breaker
 * counters) issued directly via ioredis.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CLIENT_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Redis =>
        new Redis(config.get('REDIS_URL', { infer: true }), {
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        }),
    },
  ],
  exports: [REDIS_CLIENT_TOKEN],
})
export class RedisModule {}
