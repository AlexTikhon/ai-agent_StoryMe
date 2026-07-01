import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

  // ── Security ──────────────────────────────────────────────────────────────
  app.use(helmet());

  // ── CORS ──────────────────────────────────────────────────────────────────
  const allowedOrigins = (process.env['ALLOWED_ORIGINS'] ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim());

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-ID',
      // Dev-only auth headers — remove once real auth replaces DevAuthGuard.
      'x-user-email',
      'x-user-name',
    ],
  });

  // ── Global prefix ─────────────────────────────────────────────────────────
  app.setGlobalPrefix('api');

  // ── Global validation pipe ────────────────────────────────────────────────
  // whitelist: strips unknown fields; forbidNonWhitelisted: 400 on unknown fields
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: false,
      },
    }),
  );

  // ── Global exception filter ───────────────────────────────────────────────
  app.useGlobalFilters(new HttpExceptionFilter());

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  app.enableShutdownHooks();

  const port = Number(process.env['PORT'] ?? 4000);
  await app.listen(port, '0.0.0.0');
  logger.log(`API running on http://localhost:${port}/api`);
  logger.log(`Health check: http://localhost:${port}/api/health`);
}

bootstrap().catch((err: unknown) => {
  console.error('Fatal error during bootstrap:', err);
  process.exit(1);
});
