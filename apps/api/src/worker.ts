import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { envPresent, logStartup } from './common/startup-log';
import { QUEUES } from './queue/queues.config';
import { assertPdfStorageSupportsWorker } from './pdf/pdf-storage';
import { assertImageStorageSupportsWorker } from './images/image-asset-storage';

/**
 * Dedicated generation-worker process — consumes BullMQ book-generation jobs
 * via GenerationQueueProcessor and never exposes an HTTP server (no
 * NestFactory.create/app.listen). Reuses the exact same module graph as the
 * API (main.ts) via AppModule.register, just with the processor enabled.
 * See "Worker process separation" in apps/api/docs/local-generation-pipeline.md.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');

  // Fail fast, before opening any DB/Redis connection, if this process would
  // generate artifacts no API instance could read back or fully hard-delete.
  // The deploy preflight checks the same invariant, but worker boot must stay
  // safe even when an operator accidentally skips that separate command.
  assertPdfStorageSupportsWorker(process.env);
  assertImageStorageSupportsWorker(process.env);

  logStartup(logger, {
    mode: 'worker',
    workerEnabled: true,
    queueName: QUEUES.BOOK_GENERATION,
    processorRegistered: true,
    redisUrlPresent: envPresent(process.env['REDIS_URL']),
    databaseUrlPresent: envPresent(process.env['DATABASE_URL']),
  });
  const app = await NestFactory.createApplicationContext(
    AppModule.register({ enableGenerationWorker: true }),
    { logger: ['error', 'warn', 'log', 'debug'] },
  );

  app.enableShutdownHooks();

  logger.log('Generation worker started — consuming book-generation jobs (no HTTP server).');
}

bootstrap().catch((err: unknown) => {
  console.error('Fatal error during worker bootstrap:', err);
  process.exit(1);
});
