import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller, Get, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { buildCorsOptions } from '../../src/config/cors.config';

const WEB_ORIGIN = 'https://web.storyme.example';

@Controller('health')
class CorsTestController {
  @Get()
  health(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [CorsTestController] })
class CorsTestModule {}

describe('CORS through the real Nest HTTP stack', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(CorsTestModule, { logger: false });
    app.enableCors(buildCorsOptions({ ALLOWED_ORIGINS: WEB_ORIGIN }));
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows the billing Idempotency-Key header in a cross-origin preflight', async () => {
    const response = await fetch(`${baseUrl}/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: WEB_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,idempotency-key',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');

    const allowedHeaders =
      response.headers
        .get('access-control-allow-headers')
        ?.toLowerCase()
        .split(',')
        .map((header) => header.trim()) ?? [];
    expect(allowedHeaders).toContain('idempotency-key');
  });
});
