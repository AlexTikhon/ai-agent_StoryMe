import { describe, it, expect } from 'vitest';
import { buildCheckoutIdempotencyKey } from './checkout-idempotency-key';

describe('buildCheckoutIdempotencyKey', () => {
  it('scopes a safe header value by user id', () => {
    const key = buildCheckoutIdempotencyKey('user-1', 'retry-abc123');
    expect(key).toBe('checkout:user-1:retry-abc123');
  });

  it('produces different keys for two different users supplying the identical raw header value', () => {
    const keyA = buildCheckoutIdempotencyKey('user-a', 'same-client-key');
    const keyB = buildCheckoutIdempotencyKey('user-b', 'same-client-key');
    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe('checkout:user-a:same-client-key');
    expect(keyB).toBe('checkout:user-b:same-client-key');
  });

  it('is deterministic for the same user and header value across calls (enables retry dedupe)', () => {
    const keyA = buildCheckoutIdempotencyKey('user-1', 'retry-abc123');
    const keyB = buildCheckoutIdempotencyKey('user-1', 'retry-abc123');
    expect(keyA).toBe(keyB);
  });

  it('falls back to a random per-call suffix when the header is missing', () => {
    const keyA = buildCheckoutIdempotencyKey('user-1', undefined);
    const keyB = buildCheckoutIdempotencyKey('user-1', undefined);
    expect(keyA).not.toBe(keyB);
    expect(keyA.startsWith('checkout:user-1:auto:')).toBe(true);
  });

  it('falls back to a random suffix when the header contains unsafe characters', () => {
    const key = buildCheckoutIdempotencyKey('user-1', '../etc/passwd; DROP TABLE');
    expect(key.startsWith('checkout:user-1:auto:')).toBe(true);
  });

  it('falls back to a random suffix when the header exceeds the length bound', () => {
    const tooLong = 'a'.repeat(201);
    const key = buildCheckoutIdempotencyKey('user-1', tooLong);
    expect(key.startsWith('checkout:user-1:auto:')).toBe(true);
  });

  it('accepts a header at exactly the length bound', () => {
    const exact = 'a'.repeat(200);
    const key = buildCheckoutIdempotencyKey('user-1', exact);
    expect(key).toBe(`checkout:user-1:${exact}`);
  });
});
