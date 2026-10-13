import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  ConflictException,
  Logger,
  NotFoundException,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { User } from '@prisma/client';
import { AuthModeGuard } from '../auth/auth-mode.guard';
import { RequireVerifiedEmailGuard } from '../auth/require-verified-email.guard';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import { BooksController } from './books.controller';
import { BooksService } from './books.service';

/**
 * Real HTTP through Nest's Express adapter, mirroring
 * books.controller.published-image-http.spec.ts for the PDF preview route.
 *
 * Phase 16.6: BooksService.getPreviewPdfBuffer is awaited before anything is
 * written. If the client has already left by the time it resolves, the adapter
 * pipes the returned StreamableFile into a destroyed response, which throws
 * ERR_STREAM_UNABLE_TO_PIPE and is logged as an unhandled 500 even though the
 * PDF itself was read fine.
 */

// Vitest's esbuild transform does not emit `design:paramtypes`, so Nest cannot
// infer the controller's constructor dependency. Declare it the way tsc would.
(
  Reflect as unknown as {
    defineMetadata(key: string, value: unknown, target: object): void;
  }
).defineMetadata('design:paramtypes', [BooksService], BooksController);

const BOOK_ID = '11111111-1111-4111-8111-111111111111';
// Header plus bytes that are not valid UTF-8, so any text re-encoding on the
// way out would change the body and fail the exact-bytes assertion.
const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4\n%'),
  Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x00, 0xff, 0xfe]),
  Buffer.from('\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n'),
]);
const PDF_RESULT = {
  buffer: PDF_BYTES,
  contentType: 'application/pdf' as const,
  filename: 'storyme-preview-phase-16-6.pdf',
};

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

describe('GET /books/:id/pdf/preview over real HTTP', () => {
  let app: INestApplication | undefined;
  let port: number;
  const booksService = { getPreviewPdfBuffer: vi.fn() };
  let loggerError: MockInstance;
  let unhandledRejections: unknown[];
  // Everything a test opens or holds, so afterEach can release it on any path.
  let openRequests: ClientRequest[];
  let heldGates: Array<() => void>;

  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };

  beforeEach(async () => {
    booksService.getPreviewPdfBuffer.mockReset();
    unhandledRejections = [];
    openRequests = [];
    heldGates = [];
    process.on('unhandledRejection', onUnhandledRejection);
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
    try {
      // Release held service calls, then drop every client socket first, so
      // app.close() cannot wait on a connection a failed test left open.
      for (const release of heldGates) release();
      for (const req of openRequests) req.destroy();
      if (app) {
        (app.getHttpServer() as Server).closeAllConnections();
        await app.close();
      }
    } finally {
      app = undefined;
      process.off('unhandledRejection', onUnhandledRejection);
      loggerError.mockRestore();
    }
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
        res.on('error', reject);
      });
      openRequests.push(req);
      req.on('error', reject);
      req.end();
    });
  }

  function unhandledExceptionLogs(): string[] {
    return loggerError.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith('Unhandled exception'));
  }

  it('serves the PDF with the existing headers and the exact bytes to a connected client', async () => {
    booksService.getPreviewPdfBuffer.mockResolvedValue(PDF_RESULT);

    const result = await get(`/books/${BOOK_ID}/pdf/preview`);

    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('application/pdf');
    expect(result.headers['content-disposition']).toBe(`inline; filename="${PDF_RESULT.filename}"`);
    expect(result.headers['content-length']).toBe(String(PDF_BYTES.length));
    expect(result.body.equals(PDF_BYTES)).toBe(true);
    expect(booksService.getPreviewPdfBuffer).toHaveBeenCalledWith(BOOK_ID, 'user-1', undefined);
    expect(unhandledExceptionLogs()).toEqual([]);
    expect(unhandledRejections).toEqual([]);
  });

  it('does not report an unhandled 500 when the client aborts before the PDF is ready', async () => {
    const gate = deferred<typeof PDF_RESULT>();
    heldGates.push(() => gate.resolve(PDF_RESULT));
    const handlerReached = deferred<void>();
    booksService.getPreviewPdfBuffer.mockImplementation(() => {
      handlerReached.resolve();
      return gate.promise;
    });

    const server = app!.getHttpServer() as Server;
    const socketClosed = new Promise<void>((resolve) => {
      server.once('connection', (socket) => socket.once('close', () => resolve()));
    });

    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: `/books/${BOOK_ID}/pdf/preview`,
      method: 'GET',
    });
    openRequests.push(req);
    req.on('error', () => undefined); // the abort surfaces as ECONNRESET on the client
    req.end();

    // 1. The handler is parked inside the service call, nothing written yet.
    await handlerReached.promise;
    // 2. The client leaves, and the server has observed its socket closing.
    req.destroy();
    await socketClosed;
    await tick();

    // 3. Only now does the PDF read succeed, for a client that is already gone.
    gate.resolve(PDF_RESULT);
    await tick();
    await tick();

    expect(booksService.getPreviewPdfBuffer).toHaveBeenCalledTimes(1);
    expect(unhandledExceptionLogs()).toEqual([]);
    expect(unhandledRejections).toEqual([]);
  });

  it('keeps the 404 contract when the PDF is missing or not visible', async () => {
    booksService.getPreviewPdfBuffer.mockRejectedValue(
      new NotFoundException('PDF file not found in storage'),
    );

    const result = await get(`/books/${BOOK_ID}/pdf/preview`);

    expect(result.status).toBe(404);
    expect(JSON.parse(result.body.toString('utf8'))).toMatchObject({
      statusCode: 404,
      message: 'PDF file not found in storage',
    });
    expect(unhandledExceptionLogs()).toEqual([]);
  });

  it('keeps the 409 contract when the PDF is not ready', async () => {
    booksService.getPreviewPdfBuffer.mockRejectedValue(
      new ConflictException('PDF not ready — book generation is not complete'),
    );

    const result = await get(`/books/${BOOK_ID}/pdf/preview`);

    expect(result.status).toBe(409);
    expect(JSON.parse(result.body.toString('utf8'))).toMatchObject({
      statusCode: 409,
      message: 'PDF not ready — book generation is not complete',
    });
    expect(unhandledExceptionLogs()).toEqual([]);
  });

  it('keeps the 409 PUBLISHED_EDITION_CHANGED contract for a stale edition', async () => {
    booksService.getPreviewPdfBuffer.mockRejectedValue(
      new ConflictException('PUBLISHED_EDITION_CHANGED'),
    );

    const result = await get(`/books/${BOOK_ID}/pdf/preview?edition=stale-edition`);

    expect(result.status).toBe(409);
    expect(JSON.parse(result.body.toString('utf8'))).toMatchObject({
      statusCode: 409,
      message: 'PUBLISHED_EDITION_CHANGED',
    });
    expect(booksService.getPreviewPdfBuffer).toHaveBeenCalledWith(
      BOOK_ID,
      'user-1',
      'stale-edition',
    );
    expect(unhandledExceptionLogs()).toEqual([]);
  });

  it('still answers a genuine service failure with the sanitized 500 and logs it', async () => {
    booksService.getPreviewPdfBuffer.mockRejectedValue(
      new Error('ECONNREFUSED storage.internal:9000 secret-token'),
    );

    const result = await get(`/books/${BOOK_ID}/pdf/preview`);

    expect(result.status).toBe(500);
    const body = JSON.parse(result.body.toString('utf8')) as Record<string, unknown>;
    expect(body).toMatchObject({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
    });
    expect(result.body.toString('utf8')).not.toContain('secret-token');
    expect(result.body.toString('utf8')).not.toContain('storage.internal');
    expect(unhandledExceptionLogs()).toHaveLength(1);
  });
});
