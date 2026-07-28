import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { getRequestId, REQUEST_ID_HEADER } from './correlation-context';
import { RequestCorrelationMiddleware } from './request-correlation.middleware';

const REQUEST_ID = '22222222-2222-4222-8222-222222222222';

function makeResponse() {
  let finish: (() => void) | undefined;
  const response = {
    statusCode: 202,
    setHeader: vi.fn(),
    once: vi.fn((event: string, callback: () => void) => {
      if (event === 'finish') finish = callback;
      return response;
    }),
  } as unknown as Response;
  return { response, finish: () => finish?.() };
}

describe('RequestCorrelationMiddleware', () => {
  it('preserves a valid request ID, exposes it, and never logs query/body/header secrets', () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const request = {
      method: 'post',
      path: '/api/books/book-1/generate',
      originalUrl: '/api/books/book-1/generate?token=query-secret',
      body: { prompt: 'private story text' },
      headers: { authorization: 'Bearer header-secret' },
      get: vi.fn((name: string) => (name === REQUEST_ID_HEADER ? REQUEST_ID : undefined)),
    } as unknown as Request;
    const { response, finish } = makeResponse();
    const next = vi.fn(() => {
      expect(getRequestId()).toBe(REQUEST_ID);
    }) as NextFunction;

    new RequestCorrelationMiddleware().use(request, response, next);
    finish();

    expect(response.setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, REQUEST_ID);
    expect(next).toHaveBeenCalledOnce();
    const logs = logSpy.mock.calls.flat().join('\n');
    expect(logs).toContain(`requestId=${REQUEST_ID}`);
    expect(logs).toContain('path=/api/books/book-1/generate');
    expect(logs).toContain('statusCode=202');
    expect(logs).not.toContain('query-secret');
    expect(logs).not.toContain('private story text');
    expect(logs).not.toContain('header-secret');
    logSpy.mockRestore();
  });

  it('replaces a malformed inbound request ID instead of logging it', () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const request = {
      method: 'GET',
      path: '/api/health',
      get: vi.fn(() => 'attacker\nforged=value'),
    } as unknown as Request;
    const { response } = makeResponse();

    new RequestCorrelationMiddleware().use(request, response, vi.fn());

    const assigned = response.setHeader as unknown as ReturnType<typeof vi.fn>;
    const requestId = assigned.mock.calls[0]?.[1] as string;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(logSpy.mock.calls.flat().join('\n')).not.toContain('attacker');
    logSpy.mockRestore();
  });
});
