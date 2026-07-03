const FALLBACK_FILENAME = 'storyme-book.pdf';

/** Builds a safe, download-ready ".pdf" filename from a book title. */
export function safePdfFilename(title: string | null | undefined): string {
  const trimmed = (title ?? '').trim();
  if (!trimmed) return FALLBACK_FILENAME;

  const sanitized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return sanitized ? `${sanitized}.pdf` : FALLBACK_FILENAME;
}
