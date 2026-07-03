import { describe, it, expect, vi } from 'vitest';
import { renderStorybookPdf } from './pdf-renderer';
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
      text: 'Test Book Title',
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
    const [a, b] = await Promise.all([renderStorybookPdf(layout), renderStorybookPdf(layout)]);
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

  it('degrades to a red error page (instead of crashing) when an entry has a malformed box', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const brokenEntry = makeCoverEntry({
        imageBlock: {
          box: undefined as never,
          imageUrl: '/mock-images/test/cover.svg',
          altText: 'Cover illustration',
          objectFit: 'cover',
        },
      });
      const layout = makeLayout([brokenEntry]);

      const buf = await renderStorybookPdf(layout);

      expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Failed to render entry "${brokenEntry.id}"`),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ── text block rendering behavior ──────────────────────────────────────────────
// PDFKit's built-in `.text()` (called with width/height/align/lineGap in
// renderTextBlock) owns all line wrapping; there is no separate wrap helper.
// These tests assert observable renderer behavior — a valid, non-crashing PDF —
// rather than brittle binary snapshots.

describe('renderStorybookPdf text block edge cases', () => {
  it('renders a very long multi-paragraph text block without throwing', async () => {
    const longText = Array.from(
      { length: 20 },
      (_, i) => `Paragraph ${i + 1}: ${'word '.repeat(30).trim()}.`,
    ).join('\n\n');
    const layout = makeLayout([makePageEntry(1)]);
    layout.entries[0].textBlock!.text = longText;

    const buf = await renderStorybookPdf(layout);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('renders multiline text with explicit newlines as hard breaks', async () => {
    const layout = makeLayout([makeBackCoverEntry()]);
    const buf = await renderStorybookPdf(layout);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('renders an empty-string text block without throwing', async () => {
    const layout = makeLayout([makePageEntry(1)]);
    layout.entries[0].textBlock!.text = '';

    const buf = await renderStorybookPdf(layout);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('renders text that vastly exceeds its box height without throwing (overflow, not crash)', async () => {
    const layout = makeLayout([makePageEntry(1)]);
    layout.entries[0].textBlock!.text = 'overflow '.repeat(200).trim();
    layout.entries[0].textBlock!.box = { x: 180, y: 1420, width: 200, height: 20 };

    const buf = await renderStorybookPdf(layout);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('renders the same overflowing text block deterministically across runs', async () => {
    const layout = makeLayout([makePageEntry(1)]);
    layout.entries[0].textBlock!.text = 'overflow '.repeat(200).trim();
    layout.entries[0].textBlock!.box = { x: 180, y: 1420, width: 200, height: 20 };

    const [a, b] = await Promise.all([renderStorybookPdf(layout), renderStorybookPdf(layout)]);
    expect(a.length).toBe(b.length);
  });
});

// ── image embedding ────────────────────────────────────────────────────────────
// The renderer never fetches URLs itself; `resolveImageBuffer` is a synchronous,
// local seam a caller may supply to hand over already-available bytes. No
// caller wires this up yet (see docs/pdf-rendering.md), so omitting it must
// keep today's placeholder-only behavior unchanged.

describe('renderStorybookPdf image embedding', () => {
  // Minimal valid 1x1 PNG.
  const VALID_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const CORRUPT_BYTES = Buffer.from('this is not an image', 'utf-8');

  it('embeds real image bytes when the resolver supplies them', async () => {
    const layout = makeLayout([makeCoverEntry()]);
    const buf = await renderStorybookPdf(layout, {
      resolveImageBuffer: () => VALID_PNG,
    });

    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
    const raw = buf.toString('latin1');
    expect(raw).toContain('/Subtype /Image');
  });

  it('falls back to the placeholder rectangle when no resolver is supplied', async () => {
    const layout = makeLayout([makeCoverEntry()]);
    const buf = await renderStorybookPdf(layout);

    const raw = buf.toString('latin1');
    expect(raw).not.toContain('/Subtype /Image');
  });

  it('falls back to the placeholder when the resolver returns undefined', async () => {
    const layout = makeLayout([makeCoverEntry()]);
    const buf = await renderStorybookPdf(layout, {
      resolveImageBuffer: () => undefined,
    });

    const raw = buf.toString('latin1');
    expect(raw).not.toContain('/Subtype /Image');
  });

  it('falls back to the placeholder and warns when the resolved bytes are corrupt', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layout = makeLayout([makeCoverEntry()]);
      const buf = await renderStorybookPdf(layout, {
        resolveImageBuffer: () => CORRUPT_BYTES,
      });

      expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
      const raw = buf.toString('latin1');
      expect(raw).not.toContain('/Subtype /Image');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to embed image for entry "test-cover"'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not fail the whole PDF when one of several images is corrupt', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layout = makeLayout([makeCoverEntry(), makePageEntry(1), makeBackCoverEntry()]);
      const buf = await renderStorybookPdf(layout, {
        resolveImageBuffer: (imageBlock) =>
          imageBlock.imageUrl.includes('page-1') ? CORRUPT_BYTES : VALID_PNG,
      });

      expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
      const raw = buf.toString('latin1');
      // Cover's image embeds fine even though page 1's image is corrupt.
      expect(raw).toContain('/Subtype /Image');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to embed image for entry "test-page-1"'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('produces identically sized buffers across runs when embedding the same image bytes', async () => {
    const layout = makeLayout([makeCoverEntry(), makePageEntry(1)]);
    const [a, b] = await Promise.all([
      renderStorybookPdf(layout, { resolveImageBuffer: () => VALID_PNG }),
      renderStorybookPdf(layout, { resolveImageBuffer: () => VALID_PNG }),
    ]);
    expect(a.length).toBe(b.length);
  });
});
