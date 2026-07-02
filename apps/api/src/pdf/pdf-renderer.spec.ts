import { describe, it, expect } from 'vitest';
import { renderStorybookPdf } from './pdf-renderer';
import { wrapText } from './text-wrap';
import type { BookLayout, BookLayoutEntry } from '@book/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_CANVAS = { width: 2400, height: 2400, unit: 'px' as const };
const BASE_SAFE_AREA = { x: 180, y: 180, width: 2040, height: 2040 };

function makeCoverEntry(overrides: Partial<BookLayoutEntry> = {}): BookLayoutEntry {
  return {
    id: 'test-cover',
    kind: 'cover',
    template: 'cover_full_bleed',
    trimSize: 'square_8x8',
    canvas: BASE_CANVAS,
    safeArea: BASE_SAFE_AREA,
    bleed: 90,
    imageBlock: {
      box: { x: 0, y: 0, width: 2400, height: 2400 },
      imageUrl: '/mock-images/test/cover.svg',
      altText: 'Cover illustration',
      objectFit: 'cover',
    },
    textBlock: {
      box: { x: 180, y: 1620, width: 2040, height: 600 },
      text: "Test Book Title",
      fontFamily: 'Fraunces',
      fontSize: 32,
      lineHeight: 1.2,
      align: 'center',
      verticalAlign: 'bottom',
      color: '#FFFFFF',
    },
    notes: [],
    ...overrides,
  };
}

function makePageEntry(pageNumber: number): BookLayoutEntry {
  return {
    id: `test-page-${pageNumber}`,
    kind: 'page',
    pageNumber,
    template: 'image_top_text_bottom',
    trimSize: 'square_8x8',
    canvas: BASE_CANVAS,
    safeArea: BASE_SAFE_AREA,
    bleed: 90,
    imageBlock: {
      box: { x: 180, y: 180, width: 2040, height: 1210 },
      imageUrl: `/mock-images/test/page-${pageNumber}.svg`,
      altText: `Page ${pageNumber} illustration`,
      objectFit: 'cover',
    },
    textBlock: {
      box: { x: 180, y: 1420, width: 2040, height: 800 },
      text: `Story text for page ${pageNumber}. This is a children's book page with some meaningful content.`,
      fontFamily: 'Plus Jakarta Sans',
      fontSize: 18,
      lineHeight: 1.5,
      align: 'left',
      verticalAlign: 'top',
      color: '#1C1917',
    },
    notes: [],
  };
}

function makeBackCoverEntry(): BookLayoutEntry {
  return {
    id: 'test-back-cover',
    kind: 'back_cover',
    template: 'back_cover_summary',
    trimSize: 'square_8x8',
    canvas: BASE_CANVAS,
    safeArea: BASE_SAFE_AREA,
    bleed: 90,
    textBlock: {
      box: { x: 300, y: 600, width: 1800, height: 1200 },
      text: 'The End!\n\nWe hope you enjoyed this adventure.',
      fontFamily: 'Plus Jakarta Sans',
      fontSize: 16,
      lineHeight: 1.6,
      align: 'center',
      verticalAlign: 'middle',
      color: '#FFFFFF',
    },
    notes: [],
  };
}

function makeLayout(entries: BookLayoutEntry[]): BookLayout {
  return {
    status: 'complete',
    trimSize: 'square_8x8',
    entries,
    metadata: {
      title: 'Test Book',
      childName: 'Alex',
      totalPages: entries.filter((e) => e.kind === 'page').length,
      generatedAt: '1970-01-01T00:00:00.000Z',
    },
  };
}

// ── wrapText tests ────────────────────────────────────────────────────────────

describe('wrapText', () => {
  it('returns single line when text fits', () => {
    expect(wrapText('Hello world', 20)).toEqual(['Hello world']);
  });

  it('wraps long text into multiple lines', () => {
    const lines = wrapText('Hello world foo bar baz', 10);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(10);
    }
  });

  it('preserves explicit newlines as hard breaks', () => {
    const lines = wrapText('Hello\nWorld', 40);
    expect(lines).toEqual(['Hello', 'World']);
  });

  it('handles multi-paragraph text with explicit newlines', () => {
    const lines = wrapText('First line\n\nSecond paragraph', 40);
    expect(lines).toContain('First line');
    expect(lines).toContain('Second paragraph');
  });

  it('returns single element for empty string', () => {
    expect(wrapText('', 20)).toEqual(['']);
  });

  it('returns text unchanged when maxCharsPerLine < 1', () => {
    expect(wrapText('some text', 0)).toEqual(['some text']);
  });

  it('places a single long word on its own line', () => {
    const lines = wrapText('short superlongwordthatexceedslimit done', 10);
    expect(lines).toContain('superlongwordthatexceedslimit');
  });

  it('joined lines reproduce all words from input', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const lines = wrapText(text, 15);
    const rejoined = lines.join(' ').trim();
    expect(rejoined).toBe(text);
  });
});

// ── renderStorybookPdf tests ──────────────────────────────────────────────────

describe('renderStorybookPdf', () => {
  it('rejects with clear error when entries array is empty', async () => {
    const layout = makeLayout([]);
    await expect(renderStorybookPdf(layout)).rejects.toThrow(
      'Cannot render PDF: book has no layout entries',
    );
  });

  it('returns a Buffer for a single cover entry', async () => {
    const layout = makeLayout([makeCoverEntry()]);
    const buf = await renderStorybookPdf(layout);
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  it('returns a non-empty Buffer', async () => {
    const layout = makeLayout([makeCoverEntry()]);
    const buf = await renderStorybookPdf(layout);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('output starts with valid PDF header %PDF-', async () => {
    const layout = makeLayout([makeCoverEntry()]);
    const buf = await renderStorybookPdf(layout);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('output ends with %%EOF marker', async () => {
    const layout = makeLayout([makeCoverEntry()]);
    const buf = await renderStorybookPdf(layout);
    const tail = buf.slice(-10).toString('ascii');
    expect(tail).toContain('%%EOF');
  });

  it('produces a larger buffer for more pages', async () => {
    const singlePage = makeLayout([makeCoverEntry()]);
    const threePages = makeLayout([makeCoverEntry(), makePageEntry(1), makeBackCoverEntry()]);

    const small = await renderStorybookPdf(singlePage);
    const large = await renderStorybookPdf(threePages);

    expect(large.length).toBeGreaterThan(small.length);
  });

  it('renders full cover + pages + back cover layout', async () => {
    const layout = makeLayout([
      makeCoverEntry(),
      makePageEntry(1),
      makePageEntry(2),
      makeBackCoverEntry(),
    ]);
    const buf = await renderStorybookPdf(layout);
    expect(buf.length).toBeGreaterThan(5_000);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('output is non-trivially sized (not just a stub)', async () => {
    const layout = makeLayout([makeCoverEntry(), makePageEntry(1), makeBackCoverEntry()]);
    const buf = await renderStorybookPdf(layout);
    // 3-page PDF with placeholder graphics and text is well above 3 KB uncompressed
    expect(buf.length).toBeGreaterThan(3_000);
  });

  it('same input produces buffers of identical length (compress:false, deterministic content)', async () => {
    const layout = makeLayout([makeCoverEntry(), makePageEntry(1)]);
    const [a, b] = await Promise.all([
      renderStorybookPdf(layout),
      renderStorybookPdf(layout),
    ]);
    // Byte count must match when content and font data are identical
    expect(a.length).toBe(b.length);
  });

  it('renders entry without imageBlock (text-only page)', async () => {
    const textOnlyEntry = makeCoverEntry({ imageBlock: undefined });
    const layout = makeLayout([textOnlyEntry]);
    const buf = await renderStorybookPdf(layout);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('renders entry without textBlock (image-only page)', async () => {
    const imageOnlyEntry = makeCoverEntry({ textBlock: undefined });
    const layout = makeLayout([imageOnlyEntry]);
    const buf = await renderStorybookPdf(layout);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('renders page entry with page number footer', async () => {
    const layout = makeLayout([makePageEntry(3)]);
    const buf = await renderStorybookPdf(layout);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('embeds book metadata (title, creator) as plain text in PDF info dictionary', async () => {
    const layout = makeLayout([makeCoverEntry()]);
    const buf = await renderStorybookPdf(layout);
    // Info dictionary strings are stored as PDF literal strings, readable in raw bytes
    const raw = buf.toString('latin1');
    expect(raw).toContain('StoryMe PDF Renderer');
    expect(raw).toContain('Test Book');
  });
});
