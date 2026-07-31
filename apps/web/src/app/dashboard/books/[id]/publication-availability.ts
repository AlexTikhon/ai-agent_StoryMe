import { BookStatus, type BookDto } from '@book/types';
import { isGeneratingBookStatus } from './use-book-detail';

/**
 * Publication is a persisted artifact fact, independent of the latest
 * generation workflow status. A coherent publication needs both the
 * ownership-checked PDF pointer and the preview used by the authenticated
 * reader.
 */
export function hasPublishedBook(book: BookDto): boolean {
  return (
    hasPublishedPdf(book) &&
    book.bookPreview != null &&
    Array.isArray(book.bookPreview.pages) &&
    book.bookPreview.pages.length > 0
  );
}

export function hasPublishedPdf(book: BookDto): boolean {
  return typeof book.previewPdfUrl === 'string' && book.previewPdfUrl.trim().length > 0;
}

export function publishedVersionStatusMessage(book: BookDto): string | null {
  if (!hasPublishedBook(book) || book.status === BookStatus.Complete) return null;
  if (isGeneratingBookStatus(book.status)) {
    return 'A new version is being generated. You can continue reading the currently published version.';
  }
  if (book.status === BookStatus.Failed) {
    return 'The new version could not be generated. You can continue reading the currently published version.';
  }
  if (book.status === BookStatus.Cancelled) {
    return 'The new version was cancelled. You can continue reading the currently published version.';
  }
  return null;
}
