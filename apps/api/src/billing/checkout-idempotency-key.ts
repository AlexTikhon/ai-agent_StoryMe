import { randomUUID } from 'node:crypto';

/** Bounds an Idempotency-Key header to a safe charset/length before it's ever used for anything. */
const SAFE_IDEMPOTENCY_HEADER = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * Builds the value passed to Stripe as the Checkout Session request's own
 * idempotency key. Always prefixed with the authenticated user's id, so an
 * untrusted client-supplied header value can never collide across users
 * (two different users echoing the same raw header string still get two
 * distinct Stripe idempotency keys) — see apps/api/docs/credits.md,
 * "Phase E3". A missing or unsafe header (wrong charset, too long) falls
 * back to a fresh random suffix: the request still succeeds, it just isn't
 * deduplicated against a retry that doesn't resend the same header.
 */
export function buildCheckoutIdempotencyKey(
  userId: string,
  rawHeaderValue: string | undefined,
): string {
  const trimmed = rawHeaderValue?.trim();
  const suffix =
    trimmed && SAFE_IDEMPOTENCY_HEADER.test(trimmed) ? trimmed : `auto:${randomUUID()}`;
  return `checkout:${userId}:${suffix}`;
}
