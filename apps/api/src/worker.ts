import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { envPresent, logStartup } from './common/startup-log';
import { QUEUES } from './queue/queues.config';
import { assertPdfStorageSupportsWorker } from './pdf/pdf-storage';

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
  // generate PDFs no API instance could ever read back. See
  // assertPdfStorageSupportsWorker's own doc comment (pdf-storage.ts) and
  // "Troubleshooting: PDF ready but preview/download 404s" in
  // apps/api/docs/local-generation-pipeline.md.
  assertPdfStorageSupportsWorker(process.env);

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
