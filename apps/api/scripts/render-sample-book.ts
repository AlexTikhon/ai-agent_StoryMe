/**
 * Regenerates the public sample book's bundled PDF from its canonical fixture.
 *
 * Usage (from the repository root):
 *   pnpm --filter @book/api render:sample-book
 *
 * Reads:  apps/web/src/sample-book/sample-book.json
 *         apps/web/public/sample-book/*.svg
 * Writes: apps/web/public/sample-book/<pdf.href from the fixture>
 *
 * Fully offline: no database, Redis, credentials or provider calls. The output
 * is deterministic for unchanged inputs (fixed creation date, info-derived file
 * ID), so regenerating without content changes leaves the file untouched.
 */
import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import {
  countPdfPages,
  readSampleBookSources,
  renderSampleBookPdf,
  resolvePublicAsset,
} from './sample-book-pdf';

async function main(): Promise<void> {
  const { buffer, fingerprint, book } = await renderSampleBookPdf(readSampleBookSources());

  const pages = countPdfPages(buffer.toString('latin1'));
  if (pages !== book.pdf.pageCount) {
    throw new Error(`Rendered ${pages} pages, expected ${book.pdf.pageCount}`);
  }

  const outPath = resolvePublicAsset(book.pdf.href);
  writeFileSync(outPath, buffer);

  console.log(`Sample book: ${book.title}`);
  console.log(`Pages: ${pages}  Size: ${(buffer.length / 1024).toFixed(1)} KB`);
  console.log(`Fixture fingerprint: ${fingerprint}`);
  console.log(`Output: ${relative(process.cwd(), outPath)}`);
}

main().catch((err: unknown) => {
  console.error('Sample book PDF generation failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
