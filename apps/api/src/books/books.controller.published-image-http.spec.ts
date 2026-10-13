import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  ConflictException,
  Logger,
  NotFoundException,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import type { User } from '@prisma/client';
import { AuthModeGuard } from '../auth/auth-mode.guard';
import { RequireVerifiedEmailGuard } from '../auth/require-verified-email.guard';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { generateMockImagePng } from '../images/mock-image-producer';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import { BooksController } from './books.controller';
import { BooksService } from './books.service';

/**
 * Real HTTP through Nest's Express adapter. The controller unit specs call the
 * handler directly with a fake `res`, so they cannot see what the adapter does
 * with the returned StreamableFile once the client is gone.
 *
 * Phase 16.5: a browser reader aborts an in-flight /images/cover request when
 * the slide or component remounts. The asset service had already succeeded, but
 * the adapter then piped into a destroyed response, which throws
 * ERR_STREAM_UNABLE_TO_PIPE synchronously and was logged as an unhandled 500.
 */

// Vitest's esbuild transform does not emit `design:paramtypes`, so Nest cannot
// infer the controller's constructor dependency. Declare it the way tsc would.
(
  Reflect as unknown as {
    defineMetadata(key: string, value: unknown, target: object): void;
  }
).defineMetadata('design:paramtypes', [BooksService], BooksController);

const BOOK_ID = '11111111-1111-4111-8111-111111111111';
const COVER_PNG = generateMockImagePng('phase-16-5-cover');

interface HttpResult {
  status: number;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets every already-queued microtask and any pending close listener settle. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('GET /books/:id/images/:imageId over real HTTP', () => {
  let app: INestApplication;
  let port: number;
  const booksService = { getPublishedImage: vi.fn() };
  let loggerError: MockInstance;

  beforeEach(async () => {
    booksService.getPublishedImage.mockReset();
    loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const allowAndAttachUser = {
      canActivate: (context: {
        switchToHttp: () => { getRequest: () => { user?: User } };
      }): boolean => {
        context.switchToHttp().getRequest().user = { id: 'user-1' } as User;
        return true;
      },
    };
    const allow = { canActivate: (): boolean => true };

    const moduleRef = await Test.createTestingModule({
      controllers: [BooksController],
      providers: [{ provide: BooksService, useValue: booksService }],
    })
      .overrideGuard(AuthModeGuard)
      .useValue(allowAndAttachUser)
      .overrideGuard(UserRateLimitGuard)
      .useValue(allow)
      .overrideGuard(RequireVerifiedEmailGuard)
      .useValue(allow)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    port = ((app.getHttpServer() as Server).address() as AddressInfo).port;
  });

  afterEach(async () => {
    await app.close();
    loggerError.mockRestore();
  });

  function get(path: string): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      });
      req.on('error', reject);
      req.end();
    });
  }

  function unhandledExceptionLogs(): string[] {
    return loggerError.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith('Unhandled exception'));
  }

  it('serves a published cover as a decodable, non-empty image with the hardening headers', async () => {
    booksService.getPublishedImage.mockResolvedValue({
      buffer: COVER_PNG,
      contentType: 'image/png',
      filename: 'cover.png',
    });

    const result = await get(`/books/${BOOK_ID}/images/cover`);

    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('image/png');
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.body.length).toBeGreaterThan(0);
    expect(result.body.equals(COVER_PNG)).toBe(true);
    const metadata = await sharp(result.body).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBeGreaterThan(0);
    expect(metadata.height).toBeGreaterThan(0);
    expect(booksService.getPublishedImage).toHaveBeenCalledWith(
      BOOK_ID,
      'user-1',
      'cover',
      undefined,
    );
    expect(unhandledExceptionLogs()).toEqual([]);
  });

  it('does not report an unhandled 500 when the client aborts before the cover is ready', async () => {
    const gate = deferred<{ buffer: Buffer; contentType: 'image/png'; filename: string }>();
    const handlerReached = deferred<void>();
    booksService.getPublishedImage.mockImplementation(() => {
      handlerReached.resolve();
      return gate.promise;
    });

    const server = app.getHttpServer() as Server;
    const socketClosed = new Promise<void>((resolve) => {
      server.once('connection', (socket) => socket.once('close', () => resolve()));
    });

    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: `/books/${BOOK_ID}/images/cover`,
      method: 'GET',
    });
    req.on('error', () => undefined); // the abort surfaces as ECONNRESET on the client
    req.end();

    await handlerReached.promise;
    req.destroy();
    await socketClosed;
    await tick();

    // The asset service now succeeds for a client that has already left.
    gate.resolve({ buffer: COVER_PNG, contentType: 'image/png', filename: 'cover.png' });
    await tick();
    await tick();

    expect(booksService.getPublishedImage).toHaveBeenCalledTimes(1);
    expect(unhandledExceptionLogs()).toEqual([]);
  });

  it('keeps the existing 404 contract when the published image is missing or not visible', async () => {
    booksService.getPublishedImage.mockRejectedValue(
      new NotFoundException('Published image not found in storage'),
    );

    const result = await get(`/books/${BOOK_ID}/images/cover`);

    expect(result.status).toBe(404);
    expect(JSON.parse(result.body.toString('utf8'))).toMatchObject({
      statusCode: 404,
      message: 'Published image not found in storage',
    });
    expect(unhandledExceptionLogs()).toEqual([]);
  });

  it('keeps the 409 PUBLISHED_EDITION_CHANGED contract for a stale edition', async () => {
    booksService.getPublishedImage.mockRejectedValue(
      new ConflictException('PUBLISHED_EDITION_CHANGED'),
    );

    const result = await get(`/books/${BOOK_ID}/images/cover?edition=stale-edition`);

    expect(result.status).toBe(409);
    expect(booksService.getPublishedImage).toHaveBeenCalledWith(
      BOOK_ID,
      'user-1',
      'cover',
      'stale-edition',
    );
    expect(unhandledExceptionLogs()).toEqual([]);
  });
});
