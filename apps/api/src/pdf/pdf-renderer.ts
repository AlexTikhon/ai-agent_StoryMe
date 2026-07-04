import PDFDocument from 'pdfkit';
import type { BookLayout, BookLayoutEntry, LayoutImageBlock, LayoutTextBlock } from '@book/types';

/** PDF page size for square_8x8 trim (8 in × 72 pt/in) */
const PAGE_PT = 576;

/** Layout canvas is 2400 × 2400 px; this scale converts px → PDF points */
const SCALE = PAGE_PT / 2400;

function pt(px: number): number {
  return px * SCALE;
}

/**
 * Maps layout font families to built-in PDFKit fonts.
 * Display fonts (Fraunces/serif) → Times; body fonts → Helvetica.
 *
 * LIMITATION: PDFKit's built-in Helvetica/Times fonts only support the
 * WinAnsi (Latin-1-ish) encoding. Non-Latin and many extended Unicode
 * characters (e.g. CJK, Cyrillic, emoji) will render blank. Fixing this
 * requires embedding a real Unicode-capable TTF/OTF font via
 * `doc.registerFont(name, fontFilePathOrBuffer)` and returning its name
 * here instead of a built-in name — see docs/pdf-rendering.md for the
 * planned future-phase boundary. Do not add font files or network font
 * downloads to close this gap without an explicit phase for it.
 */
function resolveFont(fontFamily: string, isDisplay: boolean): string {
  const f = fontFamily.toLowerCase();
  const isSerif =
    f.includes('fraunces') || f.includes('lora') || f.includes('georgia') || f.includes('serif');
  if (isSerif) return isDisplay ? 'Times-Bold' : 'Times-Roman';
  return isDisplay ? 'Helvetica-Bold' : 'Helvetica';
}

/** Font size is never shrunk below this ratio of the layout's requested size. */
const MIN_FONT_SIZE_RATIO = 0.6;
/** Absolute floor, regardless of the requested font size — keeps shrunk text legible. */
const ABSOLUTE_MIN_FONT_SIZE = 9;
const FONT_SIZE_STEP = 1;

function computeLineGap(fontSize: number, lineHeight: number): number {
  return Math.max((lineHeight - 1) * fontSize, 0);
}

/**
 * Finds the largest font size (at or below `requestedFontSize`) at which
 * `text` fits within `height` when wrapped to `width`, using PDFKit's own
 * `heightOfString` measurement (so it agrees with what `.text()` will
 * actually draw). Requires `doc`'s font to already be set. Falls back to the
 * floor size if even the floor doesn't fit — the caller then relies on
 * clipping (see renderTextBlock) rather than font size alone to guarantee no
 * overflow outside the box.
 */
export function computeFittedFontSize(
  doc: PDFKit.PDFDocument,
  text: string,
  width: number,
  height: number,
  requestedFontSize: number,
  lineHeight: number,
): number {
  const minFontSize = Math.max(
    ABSOLUTE_MIN_FONT_SIZE,
    Math.floor(requestedFontSize * MIN_FONT_SIZE_RATIO),
  );

  for (let size = requestedFontSize; size >= minFontSize; size -= FONT_SIZE_STEP) {
    doc.fontSize(size);
    const measured = doc.heightOfString(text, { width, lineGap: computeLineGap(size, lineHeight) });
    if (measured <= height) return size;
  }
  return minFontSize;
}

function resolveVerticalOffset(
  verticalAlign: LayoutTextBlock['verticalAlign'],
  boxHeight: number,
  contentHeight: number,
): number {
  const remaining = Math.max(boxHeight - contentHeight, 0);
  if (verticalAlign === 'bottom') return remaining;
  if (verticalAlign === 'middle') return remaining / 2;
  return 0;
}

/**
 * Renders a text block, guaranteeing it never visibly overflows its box (and
 * therefore never bleeds into a neighboring image/text block): font size is
 * shrunk to fit first, then the drawing region is clipped to the box as a
 * hard backstop, with `ellipsis` truncating any content that still doesn't
 * fit at the minimum font size.
 */
function renderTextBlock(doc: PDFKit.PDFDocument, tb: LayoutTextBlock, isDisplay: boolean): void {
  const x = pt(tb.box.x);
  const y = pt(tb.box.y);
  const w = Math.max(pt(tb.box.width), 1);
  const h = Math.max(pt(tb.box.height), 1);

  doc.font(resolveFont(tb.fontFamily, isDisplay));

  const fontSize = computeFittedFontSize(doc, tb.text, w, h, tb.fontSize, tb.lineHeight);
  const lineGap = computeLineGap(fontSize, tb.lineHeight);
  const contentHeight = Math.min(doc.heightOfString(tb.text, { width: w, lineGap }), h);
  const yOffset = resolveVerticalOffset(tb.verticalAlign, h, contentHeight);

  doc.save();
  doc.rect(x, y, w, h).clip();
  doc
    .fontSize(fontSize)
    .fillColor(tb.color)
    .text(tb.text, x, y + yOffset, {
      width: w,
      height: h - yOffset,
      align: tb.align as 'left' | 'center' | 'right',
      lineGap,
      ellipsis: true,
    });
  doc.restore();
}

/**
 * Resolves already-available image bytes for a layout image block, if any.
 *
 * This is a purely local, synchronous seam: implementations must not fetch
 * remote URLs or call AI/image APIs. Returning `undefined` means "no bytes
 * available", which falls back to the placeholder rectangle. The current
 * pipeline (local-mock image generation, see docs/pdf-rendering.md) does not
 * yet produce real image bytes anywhere, so no caller supplies this resolver
 * today — it exists so a future phase can wire one in without changing the
 * renderer's placeholder-fallback contract.
 */
export type ImageBufferResolver = (
  imageBlock: LayoutImageBlock,
  entry: BookLayoutEntry,
) => Buffer | undefined;

export interface RenderStorybookPdfOptions {
  resolveImageBuffer?: ImageBufferResolver;
}

function renderImagePlaceholder(
  doc: PDFKit.PDFDocument,
  entry: BookLayoutEntry,
  imageBlock: LayoutImageBlock,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  doc.rect(x, y, w, h).fillAndStroke('#D4C4B4', '#B0998A');

  const label =
    imageBlock.altText.length > 0
      ? imageBlock.altText
      : entry.kind === 'page' && entry.pageNumber != null
        ? `Image placeholder: page ${entry.pageNumber}`
        : `Image placeholder: ${entry.kind}`;

  doc
    .fillColor('#6B5344')
    .font('Helvetica')
    .fontSize(7)
    .text(label, x + 4, y + h / 2 - 5, {
      width: Math.max(w - 8, 1),
      align: 'center',
    });
}

/**
 * Renders an image block: embeds real image bytes when the resolver supplies
 * them, otherwise (or on embedding failure) falls back to the placeholder
 * rectangle. A failure here degrades only this image, not the whole page —
 * see the outer per-entry try/catch in renderStorybookPdf for structural
 * failures (e.g. a malformed box).
 */
function renderImageBlock(
  doc: PDFKit.PDFDocument,
  entry: BookLayoutEntry,
  imageBlock: LayoutImageBlock,
  resolveImageBuffer: ImageBufferResolver | undefined,
): void {
  const x = pt(imageBlock.box.x);
  const y = pt(imageBlock.box.y);
  const w = Math.max(pt(imageBlock.box.width), 1);
  const h = Math.max(pt(imageBlock.box.height), 1);

  const buffer = resolveImageBuffer?.(imageBlock, entry);
  if (buffer) {
    try {
      const dims: [number, number] = [w, h];
      doc.image(buffer, x, y, {
        ...(imageBlock.objectFit === 'cover' ? { cover: dims } : { fit: dims }),
        align: 'center',
        valign: 'center',
      });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[pdf-renderer] Failed to embed image for entry "${entry.id}" (${entry.kind}): ${message}`,
      );
    }
  }

  renderImagePlaceholder(doc, entry, imageBlock, x, y, w, h);
}

function renderPage(
  doc: PDFKit.PDFDocument,
  entry: BookLayoutEntry,
  resolveImageBuffer: ImageBufferResolver | undefined,
): void {
  // Page background
  doc.rect(0, 0, PAGE_PT, PAGE_PT).fill('#F9F6F2');

  // Image block — embeds real bytes when available, else a labelled placeholder
  if (entry.imageBlock) {
    renderImageBlock(doc, entry, entry.imageBlock, resolveImageBuffer);
  }

  // Text block
  if (entry.textBlock) {
    const isDisplay = entry.kind === 'cover' || entry.kind === 'back_cover';
    renderTextBlock(doc, entry.textBlock, isDisplay);
  }

  // Page number footer for interior pages
  if (entry.kind === 'page' && entry.pageNumber != null) {
    doc
      .font('Helvetica')
      .fontSize(6)
      .fillColor('#A0A0A0')
      .text(String(entry.pageNumber), pt(180), PAGE_PT - pt(120), {
        width: PAGE_PT - pt(360),
        align: 'center',
      });
  }
}

/**
 * Renders a storybook BookLayout to a PDF buffer.
 *
 * Each BookLayoutEntry becomes one PDF page (cover → interior pages → back cover).
 * Images are embedded when `options.resolveImageBuffer` supplies bytes for a
 * block; otherwise (or if embedding fails) they render as labelled placeholder
 * rectangles. See docs/pdf-rendering.md for the image embedding boundary.
 *
 * Font sizes from the layout are used as PDF points directly (not scaled by SCALE).
 * Coordinate boxes are scaled from the 2400 px canvas to 576 pt PDF page.
 *
 * Text line wrapping is delegated entirely to PDFKit's built-in `.text()`
 * (via the width/height/align/lineGap options in renderTextBlock) — there is
 * no separate line-wrapping helper in this codebase. Before drawing, each text
 * block's font size is shrunk (down to a floor) to fit its box, and the draw
 * region is clipped to the box as a hard backstop against overflow into a
 * neighboring image/text block — see computeFittedFontSize and
 * renderTextBlock. See docs/pdf-rendering.md for current text/font behavior
 * and known limitations.
 */
export function renderStorybookPdf(
  layout: BookLayout,
  options?: RenderStorybookPdfOptions,
): Promise<Buffer> {
  if (layout.entries.length === 0) {
    return Promise.reject(new Error('Cannot render PDF: book has no layout entries'));
  }

  const resolveImageBuffer = options?.resolveImageBuffer;

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];

    const doc = new PDFDocument({
      size: [PAGE_PT, PAGE_PT],
      autoFirstPage: false,
      compress: false,
      info: {
        Title: layout.metadata.title,
        Author: layout.metadata.childName,
        Creator: 'StoryMe PDF Renderer',
        CreationDate: new Date(0),
      },
    });

    doc.on('data', (chunk) => chunks.push(chunk as Buffer));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    for (const entry of layout.entries) {
      doc.addPage({ size: [PAGE_PT, PAGE_PT] });
      try {
        renderPage(doc, entry, resolveImageBuffer);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[pdf-renderer] Failed to render entry "${entry.id}" (${entry.kind}): ${message}`,
        );
        doc
          .fillColor('#CC0000')
          .font('Helvetica')
          .fontSize(8)
          .text(`[Render error: entry ${entry.id}]`, 10, 10, { width: PAGE_PT - 20 });
      }
    }

    doc.end();
  });
}
