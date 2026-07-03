import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { BooksModule } from './books/books.module';
import { CacheModule } from './cache/cache.module';
import { EnvModule } from './config/env.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { QueueModule } from './queue/queue.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    // EnvModule must be first — it makes ConfigModule global
    EnvModule,

    // Infrastructure (global)
    DatabaseModule,
    CacheModule,
    RateLimitModule,

    // Queue (BullMQ)
    QueueModule,

    // Feature modules
    HealthModule,
    UsersModule,
    AuthModule,
    BooksModule,
  ],
})
export class AppModule {}
