import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'x-request-id';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_DURABLE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export interface CorrelationIdentifiers {
  requestId?: string;
  bookId?: string;
  runId?: string;
  revisionId?: string;
  deletionRequestId?: string;
}

const storage = new AsyncLocalStorage<Readonly<CorrelationIdentifiers>>();

export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function resolveRequestId(candidate: unknown): string {
  return isRequestId(candidate) ? candidate.toLowerCase() : randomUUID();
}

function safeDurableId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_DURABLE_ID_PATTERN.test(value) ? value : undefined;
}

export function sanitizeCorrelation(
  identifiers: CorrelationIdentifiers,
): Readonly<CorrelationIdentifiers> {
  const requestId = isRequestId(identifiers.requestId)
    ? identifiers.requestId.toLowerCase()
    : undefined;
  const bookId = safeDurableId(identifiers.bookId);
  const runId = safeDurableId(identifiers.runId);
  const revisionId = safeDurableId(identifiers.revisionId);
  const deletionRequestId = safeDurableId(identifiers.deletionRequestId);
  return {
    ...(requestId && { requestId }),
    ...(bookId && { bookId }),
    ...(runId && { runId }),
    ...(revisionId && { revisionId }),
    ...(deletionRequestId && { deletionRequestId }),
  };
}

export function runWithCorrelation<T>(identifiers: CorrelationIdentifiers, callback: () => T): T {
  return storage.run(sanitizeCorrelation(identifiers), callback);
}

export function getCorrelation(): Readonly<CorrelationIdentifiers> {
  return storage.getStore() ?? {};
}

export function getRequestId(): string | undefined {
  return getCorrelation().requestId;
}

/**
 * Stable key=value suffix for operational logs. Only explicitly allowlisted,
 * newline-free identifiers can reach the output; request bodies, query
 * strings, prompts, story text, photos, credentials, and tokens are never
 * accepted by this boundary.
 */
export function correlationFields(identifiers: CorrelationIdentifiers = {}): string {
  const safe = sanitizeCorrelation({
    ...getCorrelation(),
    ...sanitizeCorrelation(identifiers),
  });
  return [
    safe.requestId && `requestId=${safe.requestId}`,
    safe.bookId && `bookId=${safe.bookId}`,
    safe.runId && `runId=${safe.runId}`,
    safe.revisionId && `revisionId=${safe.revisionId}`,
    safe.deletionRequestId && `deletionRequestId=${safe.deletionRequestId}`,
  ]
    .filter(Boolean)
    .join(' ');
}
