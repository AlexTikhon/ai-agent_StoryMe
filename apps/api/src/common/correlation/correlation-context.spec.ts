import { describe, expect, it } from 'vitest';
import {
  correlationFields,
  getRequestId,
  isRequestId,
  resolveRequestId,
  runWithCorrelation,
  sanitizeCorrelation,
} from './correlation-context';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

describe('correlation context', () => {
  it('accepts UUID request IDs and replaces untrusted values', () => {
    expect(isRequestId(REQUEST_ID)).toBe(true);
    expect(resolveRequestId(REQUEST_ID.toUpperCase())).toBe(REQUEST_ID);
    expect(resolveRequestId('token\ninjected')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('keeps request context across async boundaries without leaking outside', async () => {
    expect(getRequestId()).toBeUndefined();

    await runWithCorrelation({ requestId: REQUEST_ID }, async () => {
      await Promise.resolve();
      expect(getRequestId()).toBe(REQUEST_ID);
      expect(correlationFields({ bookId: 'book-1', runId: 'run-1' })).toBe(
        `requestId=${REQUEST_ID} bookId=book-1 runId=run-1`,
      );
    });

    expect(getRequestId()).toBeUndefined();
  });

  it('drops identifiers that could inject content into operational logs', () => {
    const safe = sanitizeCorrelation({
      requestId: 'Bearer secret-token',
      bookId: 'book-1\nprompt=private story',
      runId: 'run-1',
      revisionId: 'revision 1',
    });

    expect(safe).toEqual({ runId: 'run-1' });
    const fields = correlationFields(safe);
    expect(fields).toBe('runId=run-1');
    expect(fields).not.toContain('private');
    expect(fields).not.toContain('secret');
  });
});
