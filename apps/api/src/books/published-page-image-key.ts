import type { GenerationArtifactNamespace } from '../agent/generation-artifact-namespace';
import { imageKeyForNamespace } from '../images/image-asset-storage';

/**
 * Resolves one published image without forcing every unchanged illustration
 * into a new namespace. Phase 4B page revisions store an exact immutable key
 * on BookPage; cover/back-cover and untouched pages continue to use the
 * whole-book publication namespace.
 */
export function publishedImageKey(
  bookId: string,
  namespace: GenerationArtifactNamespace,
  kind: 'cover' | 'page' | 'back_cover',
  pageNumber: number | undefined,
  pageOverrides: ReadonlyMap<number, string>,
): string {
  if (kind === 'page' && pageNumber !== undefined) {
    const override = pageOverrides.get(pageNumber);
    if (override) return override;
  }
  return imageKeyForNamespace(bookId, namespace, kind, pageNumber);
}
