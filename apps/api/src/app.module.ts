import { DynamicModule, Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { BooksModule, type BooksModuleOptions } from './books/books.module';
import { CacheModule } from './cache/cache.module';
import { CreditsModule } from './credits/credits.module';
import { EnvModule } from './config/env.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { QueueModule } from './queue/queue.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { RedisModule } from './redis/redis.module';
import { UsersModule } from './users/users.module';

export type AppModuleOptions = BooksModuleOptions;

/**
 * Dynamic so the API (main.ts) and worker (worker.ts) entrypoints can share
 * every module below while independently deciding whether the BullMQ
 * generation processor is registered — see "Worker process separation" in
 * apps/api/docs/local-generation-pipeline.md.
 */
@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        // EnvModule must be first — it makes ConfigModule global
        EnvModule,

        // Infrastructure (global)
        DatabaseModule,
        CacheModule,
        RedisModule,
        RateLimitModule,

        // Queue (BullMQ)
        QueueModule,

        // Feature modules
        HealthModule,
        UsersModule,
        AuthModule,
        BooksModule.register(options),
        CreditsModule,
        BillingModule,
      ],
    };
  }
}
