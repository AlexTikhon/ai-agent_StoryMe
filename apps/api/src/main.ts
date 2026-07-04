import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

  // Trust the first hop's X-Forwarded-For entry as the client IP. Every
  // recommended deploy target (Render/Fly/Railway/Vercel) puts exactly one
  // reverse proxy in front of this app — without this, req.ip resolves to
  // the proxy's own address for every request, collapsing AuthRateLimitGuard's
  // per-IP key into one shared bucket for all clients (a real self-inflicted
  // lockout risk on routes like refresh/logout that have no email to key on).
  app.set('trust proxy', 1);

  // Personalized book PDFs are intentionally NOT served as static files —
  // LocalPdfStorage/CloudPdfStorage are only ever read through
  // BooksService.getPreviewPdfBuffer (GET /api/books/:id/pdf/preview), which
  // checks ownership before returning bytes. Do not add a static/public
  // route over the PDF storage directory; that would let anyone who learns
  // or guesses a bookId download another user's book without auth.

  // ── Security ──────────────────────────────────────────────────────────────
  app.use(helmet());

  // Parses the storyme_refresh cookie into req.cookies for AuthController.
  app.use(cookieParser());

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
