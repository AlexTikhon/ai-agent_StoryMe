import { createHash } from 'node:crypto';
import type { Book } from '@prisma/client';

/**
 * Immutable copy of a book's generation-relevant fields at the moment a
 * GenerationRun is created. A `retry` run copies this from the run being
 * retried (see BooksService.retryGeneration); an `initial`/`regenerate` run
 * builds it fresh from the book's current row — see AgentService's
 * isResumableBook, which this replaces as the source of truth for "what
 * input produced this run's output."
 */
export interface GenerationInputSnapshot {
  childName: string | null;
  childAge: number | null;
  language: string | null;
  theme: string | null;
  educationalMessage: string | null;
  pageCount: number | null;
  childPhotoAssetKey: string | null;
  childPhotoContentType: string | null;
}

export function buildInputSnapshot(book: Book): GenerationInputSnapshot {
  return {
    childName: book.childName,
    childAge: book.childAge,
    language: book.language,
    theme: book.theme,
    educationalMessage: book.educationalMessage,
    pageCount: book.pageCount,
    childPhotoAssetKey: book.childPhotoAssetKey,
    childPhotoContentType: book.childPhotoContentType,
  };
}

/** Deterministic sha256 over a canonical (sorted-key) serialization — field order in the source object must never affect the hash. */
export function hashInputSnapshot(snapshot: GenerationInputSnapshot): string {
  const canonical = JSON.stringify(snapshot, Object.keys(snapshot).sort());
  return createHash('sha256').update(canonical).digest('hex');
}
