import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FINGERPRINT_PREFIX,
  SAMPLE_BOOK_FIXTURE_PATH,
  assertSampleTextFits,
  backCoverText,
  buildSampleBookLayout,
  countPdfPages,
  fingerprintSampleInputs,
  illustrationsOf,
  parseSampleBookFixture,
  readPdfInfoString,
  readSampleBookSources,
  renderSampleBookPdf,
  resolvePublicAsset,
} from './sample-book-pdf';

const fixtureRaw = readFileSync(SAMPLE_BOOK_FIXTURE_PATH, 'utf8');
const book = parseSampleBookFixture(fixtureRaw);

function mutated(change: (draft: Record<string, unknown> & typeof book) => void): string {
  const draft = JSON.parse(fixtureRaw) as Record<string, unknown> & typeof book;
  change(draft);
  return JSON.stringify(draft);
}

describe('sample book fixture → PDF layout', () => {
  it('lays out the canonical fixture as cover, four story pages and back cover', () => {
    const layout = buildSampleBookLayout(book);

    expect(layout.entries.map((entry) => entry.kind)).toEqual([
      'cover',
      'page',
      'page',
      'page',
      'page',
      'back_cover',
    ]);
    expect(layout.entries).toHaveLength(book.pdf.pageCount);
    expect(layout.metadata.title).toBe(book.title);
  });

  it('draws exactly the fixture text and illustrations, so the PDF cannot drift from the web page', () => {
    const [cover, ...rest] = buildSampleBookLayout(book).entries;
    const back = rest.pop();

    expect(cover?.textBlock?.text).toBe(book.title);
    expect(rest.map((entry) => entry.textBlock?.text)).toEqual(book.pages.map((page) => page.text));
    expect(back?.textBlock?.text).toBe(backCoverText(book));
    expect(back?.textBlock?.text).toContain(book.provenance);
    expect([cover, ...rest, back].map((entry) => entry?.imageBlock?.imageUrl)).toEqual(
      illustrationsOf(book).map((illustration) => illustration.src),
    );
  });

  it('fits every text block at its requested size (no silent shrinking or truncation)', () => {
    expect(() => assertSampleTextFits(buildSampleBookLayout(book))).not.toThrow();
  });

  it('rejects text too long for its page instead of shrinking it', () => {
    const long = parseSampleBookFixture(
      mutated((draft) => {
        draft.pages[1]!.text = `${draft.pages[1]!.text} `.repeat(3);
      }),
    );
    expect(() => assertSampleTextFits(buildSampleBookLayout(long))).toThrow(/sample-page-2/);
  });

  it.each([
    ['a missing story page', (d: typeof book) => d.pages.pop()],
    ['out-of-order page numbers', (d: typeof book) => (d.pages[0]!.pageNumber = 2)],
    ['an empty illustration alternative', (d: typeof book) => (d.pages[2]!.illustration.alt = '')],
    ['a page count that does not match', (d: typeof book) => (d.pdf.pageCount = 5)],
    [
      'a reused illustration',
      (d: typeof book) => (d.pages[1]!.illustration.src = d.pages[0]!.illustration.src),
    ],
    [
      'an asset outside /sample-book/',
      (d: typeof book) => (d.cover.illustration.src = '/images/cover.svg'),
    ],
  ])('rejects a fixture with %s', (_label, change) => {
    expect(() => parseSampleBookFixture(mutated(change))).toThrow();
  });

  it('refuses asset paths that escape the sample-book directory', () => {
    expect(() => resolvePublicAsset('/sample-book/../../package.json')).toThrow(/escapes/);
    expect(() => resolvePublicAsset('/api/books/1/pdf/preview')).toThrow(/outside/);
  });

  it('fails instead of rendering a placeholder when an illustration is missing', async () => {
    await expect(
      renderSampleBookPdf({
        fixtureRaw,
        readSvg: (src) => {
          throw new Error(`ENOENT: ${src}`);
        },
      }),
    ).rejects.toThrow(/ENOENT/);
  });

  it('changes the fingerprint when the story text or an illustration changes', () => {
    const svgs = illustrationsOf(book).map((illustration) => ({
      src: illustration.src,
      content: '<svg/>',
    }));
    const base = fingerprintSampleInputs(book, svgs);
    const edited = parseSampleBookFixture(mutated((d) => (d.pages[0]!.text = 'Different text.')));

    expect(fingerprintSampleInputs(edited, svgs)).not.toBe(base);
    expect(
      fingerprintSampleInputs(book, [{ ...svgs[0]!, content: '<svg></svg>' }, ...svgs.slice(1)]),
    ).not.toBe(base);
    expect(
      fingerprintSampleInputs(
        book,
        svgs.map((svg) => ({ ...svg, content: `${svg.content}\r\n` })),
      ),
    ).toBe(
      fingerprintSampleInputs(
        book,
        svgs.map((svg) => ({ ...svg, content: `${svg.content}\n` })),
      ),
    );
  });
});

describe('bundled sample book PDF', () => {
  const sources = readSampleBookSources();
  const raw = readFileSync(resolvePublicAsset(book.pdf.href)).toString('latin1');

  it('was regenerated from the current fixture and illustrations', () => {
    const svgs = illustrationsOf(book).map((illustration) => ({
      src: illustration.src,
      content: sources.readSvg(illustration.src),
    }));
    // A mismatch means the fixture or an SVG changed without regenerating:
    // run `pnpm --filter @book/api render:sample-book`.
    expect(readPdfInfoString(raw, 'Keywords')).toBe(
      `${FINGERPRINT_PREFIX}${fingerprintSampleInputs(book, svgs)}`,
    );
    expect(readPdfInfoString(raw, 'Title')).toBe(book.title);
    expect(readPdfInfoString(raw, 'Subject')).toBe(book.provenance);
  });

  it('has six pages with an embedded illustration on each and embedded fonts', () => {
    expect(raw.startsWith('%PDF-')).toBe(true);
    expect(countPdfPages(raw)).toBe(book.pdf.pageCount);
    expect(raw.match(/\/Subtype \/Image/g) ?? []).toHaveLength(book.pdf.pageCount);
    expect(raw).toContain('/FontFile2');
    expect(raw).toContain('NotoSans');
  });
});
