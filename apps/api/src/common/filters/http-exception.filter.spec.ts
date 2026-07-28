import { Logger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { runWithCorrelation } from '../correlation/correlation-context';
import { HttpExceptionFilter } from './http-exception.filter';

const REQUEST_ID = '33333333-3333-4333-8333-333333333333';

describe('HttpExceptionFilter', () => {
  it('returns the request ID without exposing query or exception details in logs', () => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({
          method: 'GET',
          path: '/api/books/book-1',
          originalUrl: '/api/books/book-1?token=query-secret',
        }),
      }),
    } as unknown as ArgumentsHost;
    const logSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    runWithCorrelation({ requestId: REQUEST_ID }, () => {
      new HttpExceptionFilter().catch(new Error('private story text'), host);
    });

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/books/book-1',
        requestId: REQUEST_ID,
        message: 'An unexpected error occurred',
      }),
    );
    const logs = logSpy.mock.calls.flat().join('\n');
    expect(logs).toContain(`requestId=${REQUEST_ID}`);
    expect(logs).toContain('errorName=Error');
    expect(logs).not.toContain('query-secret');
    expect(logs).not.toContain('private story text');
    logSpy.mockRestore();
  });
});
