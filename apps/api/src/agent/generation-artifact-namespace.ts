import type { Book } from '@prisma/client';

/**
 * Identifies the exact artifact storage namespace backing a Book's resumable
 * JSON or published PDF/images. `runId` alone is not enough to identify this:
 * a stalled BullMQ redelivery reclaims the *same* GenerationRun.id under a
 * new fencingVersion (see GenerationRunService.claim's doc comment), so two
 * different deliveries of one run must still resolve to two different
 * namespaces. `'legacy'` is a checked variant of this type, not a sentinel
 * string threaded through call sites by convention.
 *
 * Never carries BullMQ's per-delivery `deliveryToken` — that value is
 * infrastructure-owned and ephemeral (a fresh value on every lock
 * acquisition, including a redelivery that keeps the same fencingVersion's
 * *predecessor* alive only momentarily); `fencingVersion` is the durable
 * database fencing identity already carried by GenerationExecutionContext,
 * and is the only thing artifact storage keys are namespaced on.
 */
export type GenerationArtifactNamespace =
  | {
      readonly kind: 'claim';
      readonly runId: string;
      readonly fencingVersion: number;
    }
  | {
      readonly kind: 'legacy';
    };

/**
 * Thrown when a Book row's artifact-pointer columns are in a state the DB
 * CHECK constraints (see the Phase B, Slice B1 migration) should already
 * prevent — e.g. one of a paired runId/fencingVersion set without the other.
 * Surfaced as a loud, typed failure rather than a silent legacy fallback, so
 * a corrupted or hand-edited row is never quietly resolved to the wrong
 * artifact bytes.
 */
export class InvalidGenerationArtifactPointerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGenerationArtifactPointerError';
  }
}

export const LEGACY_NAMESPACE: GenerationArtifactNamespace = { kind: 'legacy' };

/**
 * The claim-only half of GenerationArtifactNamespace, named for driver methods
 * (Phase B, Slice B2 — see ../images/image-asset-storage.ts / ../pdf/pdf-storage.ts)
 * that must never accept `{ kind: 'legacy' }`: unlike the resolvers above (which
 * legitimately produce either variant for the existing positional call sites),
 * a claim-scoped save/read/exists method has no legacy fallback to convert to —
 * accepting only this type makes that a compile-time guarantee, not a runtime check.
 */
export type ClaimArtifactNamespace = Extract<GenerationArtifactNamespace, { kind: 'claim' }>;

/** Matches the safe path-segment convention already used for storage keys (see ImageAssetStorage's validateImageAssetKey / PdfStorage's validateBookId) — no separators, no traversal. */
const SAFE_SEGMENT_PATTERN = /^[\w-]+$/;

/**
 * Builds and validates a claim namespace. `fencingVersion` must be a
 * positive integer: GenerationRun.fencingVersion starts at 0 and is only
 * ever incremented by a guarded claim/heartbeat/recovery-forced-failure
 * before a run can produce any Phase-1 output (see GenerationRunService.
 * claim), so 0 or negative can never correspond to a real claim that wrote
 * anything.
 */
export function claimNamespace(runId: string, fencingVersion: number): ClaimArtifactNamespace {
  if (!SAFE_SEGMENT_PATTERN.test(runId)) {
    throw new InvalidGenerationArtifactPointerError(
      `Invalid runId for artifact namespace: "${runId}"`,
    );
  }
  if (!Number.isInteger(fencingVersion) || fencingVersion <= 0) {
    throw new InvalidGenerationArtifactPointerError(
      `Invalid fencingVersion for artifact namespace: ${fencingVersion} (must be a positive integer)`,
    );
  }
  return { kind: 'claim', runId, fencingVersion };
}

/**
 * Shared logical base path for every claim-scoped artifact belonging to one
 * claim: `books/{bookId}/runs/{runId}/claims/{fencingVersion}`. Deliberately
 * driver-agnostic — it never adds a storage-driver prefix (S3's `images/` or
 * `previews/`, the local filesystem's `tmp/` root); each driver-specific key
 * builder (see image-asset-storage.ts / pdf-storage.ts) appends exactly one
 * such prefix on top of this, exactly as the existing legacy key builders do
 * for their own (non-claim-scoped) keys — so a claim-scoped key can never
 * accidentally duplicate a prefix a driver adds separately.
 */
export function claimArtifactBasePath(bookId: string, namespace: ClaimArtifactNamespace): string {
  if (!SAFE_SEGMENT_PATTERN.test(bookId)) {
    throw new InvalidGenerationArtifactPointerError(
      `Invalid bookId for artifact namespace: "${bookId}"`,
    );
  }
  // Re-validates runId/fencingVersion rather than trusting the caller to have
  // gone through claimNamespace()/the resolvers above — GenerationArtifactNamespace
  // is a structural type, so a caller can construct a { kind: 'claim', ... }
  // literal directly (e.g. in a test, or a future call site) without ever
  // calling claimNamespace(). Every path that produces a real storage key
  // must reject a malformed runId or non-positive fencingVersion, not just
  // the namespace constructors.
  claimNamespace(namespace.runId, namespace.fencingVersion);
  return `books/${bookId}/runs/${namespace.runId}/claims/${namespace.fencingVersion}`;
}

/**
 * Resolves the namespace backing whatever resumable story/character/image
 * JSON currently sits on `book` (see AgentService.isResumableBook) — this is
 * *not* necessarily the published namespace (resolvePublishedNamespace):a
 * failed regenerate attempt moves this pointer to its own claim without ever
 * touching what's published. Both fields null means the row predates Phase B
 * (or no run has ever reached Phase 1 for this book) — legacy positional
 * storage, a valid and permanent state, not a gap to fill in.
 */
export function resolveLastGenerationNamespace(
  book: Pick<Book, 'lastGenerationRunId' | 'lastGenerationFencingVersion'>,
): GenerationArtifactNamespace {
  const runId = book.lastGenerationRunId;
  const fencingVersion = book.lastGenerationFencingVersion;

  if (runId == null && fencingVersion == null) return LEGACY_NAMESPACE;
  if (runId == null || fencingVersion == null) {
    throw new InvalidGenerationArtifactPointerError(
      `Book has a partial lastGeneration artifact pointer (lastGenerationRunId=${runId ?? 'null'}, ` +
        `lastGenerationFencingVersion=${fencingVersion ?? 'null'}) — both must be set together or both null.`,
    );
  }
  return claimNamespace(runId, fencingVersion);
}

/**
 * Structural equality for two namespaces — both `'legacy'`, or both `'claim'`
 * with the same exact `(runId, fencingVersion)`. Used by the Phase B, Slice
 * B3 copy-forward algorithm to decide whether a resolved source namespace is
 * actually distinct from the current claim (see AgentService): when they're
 * equal, "check the source" and "check the current claim" would read the
 * exact same key, so there's nothing to copy forward.
 */
export function namespacesEqual(
  a: GenerationArtifactNamespace,
  b: GenerationArtifactNamespace,
): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'legacy') return true;
  return (
    a.runId === (b as ClaimArtifactNamespace).runId &&
    a.fencingVersion === (b as ClaimArtifactNamespace).fencingVersion
  );
}

/**
 * Resolves the namespace backing the currently *published* (user-visible)
 * PDF/images — written only by GenerationRunCoordinator.completeRun, and
 * only on success. Three valid states, unlike resolveLastGenerationNamespace's
 * two: no publication yet (both null), a legacy publication (publishedRunId
 * set, no fencing version — a pre-Phase-B completion), or an exact claim
 * (both set). A fencing version without a publishedRunId can never
 * disambiguate a run that doesn't exist, so that combination is rejected.
 */
export function resolvePublishedNamespace(
  book: Pick<Book, 'publishedRunId' | 'publishedRunFencingVersion'>,
): GenerationArtifactNamespace | null {
  const runId = book.publishedRunId;
  const fencingVersion = book.publishedRunFencingVersion;

  if (runId == null) {
    if (fencingVersion != null) {
      throw new InvalidGenerationArtifactPointerError(
        `Book has publishedRunFencingVersion=${fencingVersion} but no publishedRunId — a fencing ` +
          `version can never disambiguate a run that doesn't exist.`,
      );
    }
    return null;
  }
  return fencingVersion == null ? LEGACY_NAMESPACE : claimNamespace(runId, fencingVersion);
}

/**
 * resolvePublishedNamespace's three "no exact claim pointer" outcomes
 * collapsed into one: a real publication exists but predates Phase B
 * (`null` from that function, `previewPdfUrl` set — pre-GenerationRun or
 * pre-Phase-B), or nothing has ever been published for this book at all
 * (`null` from that function, `previewPdfUrl` unset). `resolvePublishedNamespace`
 * alone cannot tell these two apart — both look like "both pointer fields
 * null" to it — so this is the one place that distinction is made, instead of
 * every PDF read call site (BooksService.getPreviewPdfBuffer/
 * getGenerationDiagnostics, AgentService's pre-render diagnostics) repeating
 * the same null-state matrix independently (Phase B, Slice B4).
 */
export type PublishedPdfNamespace = GenerationArtifactNamespace | { readonly kind: 'not_ready' };

/**
 * The single resolver every production PDF read/existence path must go
 * through (see this type's own doc comment for why). Never infers ownership
 * from activeRunId, lastGenerationRunId/lastGenerationFencingVersion, the
 * latest GenerationRun, or Book.status alone — only the published pointer
 * pair, with previewPdfUrl used strictly to disambiguate the "both pointer
 * fields null" case, never as an ownership signal in its own right.
 */
export function resolvePublishedPdfNamespace(
  book: Pick<Book, 'publishedRunId' | 'publishedRunFencingVersion' | 'previewPdfUrl'>,
): PublishedPdfNamespace {
  const namespace = resolvePublishedNamespace(book);
  if (namespace != null) return namespace;
  return book.previewPdfUrl != null ? LEGACY_NAMESPACE : { kind: 'not_ready' };
}
