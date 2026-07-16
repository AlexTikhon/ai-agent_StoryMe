/**
 * Phase C — the single, shared parser for the exact Phase B claim-key grammar
 * (see claimArtifactBasePath in generation-artifact-namespace.ts):
 *
 *   [images/]books/{bookId}/runs/{runId}/claims/{fencingVersion}/{...relativeSegments}
 *
 * The leading "images/" segment is the one difference between the two
 * storage drivers' physical key layouts — ImageAssetStorage prepends it (see
 * imageObjectKey), PdfStorage does not (claimPreviewPdfKey is used directly
 * as the object key). Every other segment is identical between the two, so
 * this parser strips that one optional prefix and otherwise applies one
 * grammar uniformly, rather than duplicating parsing/validation logic once
 * per storage driver.
 *
 * Deliberately rejects anything that doesn't match exactly — a malformed,
 * partial, or merely similar-looking key (wrong literal segment, non-numeric
 * fencing version, an unsafe or traversal-like segment) must be reported as
 * unparseable by the caller (ClaimArtifactCleanupService), never guessed at
 * or coerced into a namespace.
 */
export interface ParsedClaimArtifactKey {
  readonly bookId: string;
  readonly runId: string;
  readonly fencingVersion: number;
  /** Segments after "claims/{fencingVersion}/" — e.g. ["cover.png"] or ["storyme-preview-<bookId>.pdf"]. Never empty. */
  readonly relativeSegments: readonly string[];
}

/** Matches the safe path-segment convention already used for storage keys (SAFE_SEGMENT_PATTERN in generation-artifact-namespace.ts) — no separators, no traversal. */
const SAFE_ID_SEGMENT = /^[\w-]+$/;

/** Relative artifact filename segments may contain a "." (extensions) that bookId/runId never do — but ".", ".." and empty segments are explicitly rejected below regardless of this pattern. */
const SAFE_RELATIVE_SEGMENT = /^[\w.-]+$/;

/** No leading zeros, no sign, no decimal point — must be the canonical decimal form of a positive integer, matching claimNamespace's own fencingVersion > 0 invariant. */
const POSITIVE_INTEGER_LITERAL = /^[1-9]\d*$/;

export function parseClaimArtifactStorageKey(rawKey: string): ParsedClaimArtifactKey | null {
  if (typeof rawKey !== 'string' || rawKey.length === 0) return null;

  const key = rawKey.startsWith('images/') ? rawKey.slice('images/'.length) : rawKey;
  const segments = key.split('/');
  // books, {bookId}, runs, {runId}, claims, {fencingVersion}, +at least one relative segment
  if (segments.length < 7) return null;

  const [booksLit, bookId, runsLit, runId, claimsLit, fencingVersionLiteral, ...relativeSegments] =
    segments;
  if (booksLit !== 'books' || runsLit !== 'runs' || claimsLit !== 'claims') return null;
  if (!bookId || !SAFE_ID_SEGMENT.test(bookId)) return null;
  if (!runId || !SAFE_ID_SEGMENT.test(runId)) return null;
  if (!fencingVersionLiteral || !POSITIVE_INTEGER_LITERAL.test(fencingVersionLiteral)) return null;

  const fencingVersion = Number(fencingVersionLiteral);
  if (!Number.isSafeInteger(fencingVersion) || fencingVersion <= 0) return null;

  if (relativeSegments.length === 0) return null;
  for (const segment of relativeSegments) {
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      !SAFE_RELATIVE_SEGMENT.test(segment)
    ) {
      return null;
    }
  }

  return { bookId, runId, fencingVersion, relativeSegments };
}

/** Stable grouping key for the exact (bookId, runId, fencingVersion) namespace a parsed key belongs to — a colon can never appear in a validated bookId/runId segment (SAFE_ID_SEGMENT), so this can never collide across distinct namespaces. */
export function claimArtifactNamespaceGroupKey(
  bookId: string,
  runId: string,
  fencingVersion: number,
): string {
  return bookId + ':' + runId + ':' + String(fencingVersion);
}

/**
 * Shared listing/deletion contracts implemented by both ImageAssetStorage and
 * PdfStorage (Phase C). `key` is always the exact raw/physical storage key —
 * local disk: the path relative to that driver's root; cloud: the literal S3
 * object key — so a key returned from listClaimArtifacts can always be passed
 * straight back into deleteClaimArtifacts with no re-derivation. Callers
 * (ClaimArtifactCleanupService) are the only place that parses these keys via
 * parseClaimArtifactStorageKey — drivers themselves never interpret the
 * claim-key grammar, they just transport whichever keys already exist.
 */
export interface ClaimArtifactStorageEntry {
  readonly key: string;
  readonly size: number | undefined;
  readonly lastModified: Date | undefined;
}

export interface ClaimArtifactListPage {
  readonly entries: readonly ClaimArtifactStorageEntry[];
  /** Opaque — pass back verbatim as `cursor` to continue. `null` means there is nothing more to list. */
  readonly nextCursor: string | null;
}

export interface ClaimArtifactListParams {
  readonly cursor?: string | null;
  /** Requested page size — every driver additionally clamps this to its own provider/traversal limit. */
  readonly pageSize: number;
}

export type ClaimArtifactDeleteOutcome =
  | { readonly key: string; readonly outcome: 'deleted' | 'not_found' }
  | { readonly key: string; readonly outcome: 'failed'; readonly error: string };
