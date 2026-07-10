import PDFDocument from 'pdfkit';
import path from 'path';
import type { BookLayout, BookLayoutEntry, LayoutImageBlock, LayoutTextBlock } from '@book/types';

/**
 * Embedded Unicode font (Noto Sans, SIL Open Font License 1.1 — see
 * assets/fonts/OFL.txt) covering Latin, Cyrillic, and Greek scripts, so
 * Russian/Polish text renders as real glyphs instead of blank boxes or
 * mojibake. Registered once per document under these names — see
 * `registerFonts` and docs/pdf-rendering.md.
 */
const FONT_REGULAR_NAME = 'NotoSans';
const FONT_BOLD_NAME = 'NotoSans-Bold';
const FONT_REGULAR_PATH = path.join(
  __dirname,
  '..',
  '..',
  'assets',
  'fonts',
  'NotoSans-Regular.ttf',
);
const FONT_BOLD_PATH = path.join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSans-Bold.ttf');

/** Registers the embedded Unicode fonts on a document; call once before drawing any text. */
function registerFonts(doc: PDFKit.PDFDocument): void {
  doc.registerFont(FONT_REGULAR_NAME, FONT_REGULAR_PATH);
  doc.registerFont(FONT_BOLD_NAME, FONT_BOLD_PATH);
}

/** PDF page size for square_8x8 trim (8 in × 72 pt/in) */
const PAGE_PT = 576;

/** Layout canvas is 2400 × 2400 px; this scale converts px → PDF points */
const SCALE = PAGE_PT / 2400;

function pt(px: number): number {
  return px * SCALE;
}

/**
 * Maps layout font families to the registered embedded Unicode font.
 *
 * All layout font families (serif display fonts included) resolve to the
 * same embedded Noto Sans family — PDFKit's built-in Helvetica/Times fonts
 * only support the WinAnsi (Latin-1-ish) encoding and cannot render
 * Cyrillic/other non-Latin text at all, so they are never used for
 * user-visible story text. See docs/pdf-rendering.md.
 */
function resolveFont(_fontFamily: string, isDisplay: boolean): string {
  return isDisplay ? FONT_BOLD_NAME : FONT_REGULAR_NAME;
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

  // Clip the label too: a long altText at a small box size can otherwise
  // overflow the placeholder rectangle and bleed into the page's text block,
  // the same class of bug fixed for real images below.
  doc.save();
  doc.rect(x, y, w, h).clip();
  doc
    .fillColor('#6B5344')
    .font(FONT_REGULAR_NAME)
    .fontSize(7)
    .text(label, x + 4, y + h / 2 - 5, {
      width: Math.max(w - 8, 1),
      align: 'center',
    });
  doc.restore();
}

/**
 * Renders an image block: embeds real image bytes when the resolver supplies
 * them, otherwise (or on embedding failure) falls back to the placeholder
 * rectangle. A failure here degrades only this image, not the whole page —
 * see the outer per-entry try/catch in renderStorybookPdf for structural
 * failures (e.g. a malformed box).
 *
 * PDFKit's `cover` option scales the source image to fill the requested
 * rectangle *before* centering it, so a source image whose aspect ratio
 * doesn't match the box (e.g. a square mock image dropped into a tall/narrow
 * imageBox) is scaled up until it fills the box on one axis and overhangs it
 * on the other — `fit` can overhang similarly if `align`/`valign` push it off
 * center. PDFKit does not clip `.image()` draws to the target box itself, so
 * without an explicit clip the overhang bleeds into whatever is drawn next
 * (typically the neighboring textBlock). We therefore always clip to
 * imageBlock.box before drawing, regardless of objectFit.
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
    doc.save();
    try {
      doc.rect(x, y, w, h).clip();
      const dims: [number, number] = [w, h];
      doc.image(buffer, x, y, {
        ...(imageBlock.objectFit === 'cover' ? { cover: dims } : { fit: dims }),
        align: 'center',
        valign: 'center',
      });
      doc.restore();
      return;
    } catch (err) {
      doc.restore();
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[pdf-renderer] Failed to embed image for entry "${entry.id}" (${entry.kind}): ${message}`,
      );
    }
  }

  renderImagePlaceholder(doc, entry, imageBlock, x, y, w, h);
}

/**
 * Draws a semi-opaque dark backdrop behind a cover/back-cover text block
 * before the text itself is drawn, so light text stays readable over a busy
 * illustration instead of sitting directly on it. Cover/back-cover text is
 * always white (see agent.service.ts buildBookLayout) and always overlays a
 * full-bleed illustration, so this scrim is unconditional for those two
 * entry kinds — never drawn for interior pages, whose dark text already sits
 * on a plain background.
 */
function renderTextScrim(doc: PDFKit.PDFDocument, tb: LayoutTextBlock): void {
  const x = pt(tb.box.x);
  const y = pt(tb.box.y);
  const w = Math.max(pt(tb.box.width), 1);
  const h = Math.max(pt(tb.box.height), 1);

  doc.save();
  doc.rect(x, y, w, h).fillOpacity(0.45).fill('#000000');
  doc.restore();
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
    if (isDisplay) {
      renderTextScrim(doc, entry.textBlock);
    }
    renderTextBlock(doc, entry.textBlock, isDisplay);
  }

  // Page number footer for interior pages
  if (entry.kind === 'page' && entry.pageNumber != null) {
    doc
      .font(FONT_REGULAR_NAME)
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
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
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

    registerFonts(doc);

    for (const entry of layout.entries) {
      // margins: 0 is required here (not just on the constructor): PDFKit
      // resolves each new page's margins from these addPage options, and any
      // text drawn without an explicit `height` (e.g. the page-number footer
      // below) auto-page-breaks once its y-coordinate passes
      // `page.height - margins.bottom` — with the default 72pt margin, the
      // footer's y sits past that line and silently spills onto a blank new
      // page instead of drawing on the current one.
      doc.addPage({ size: [PAGE_PT, PAGE_PT], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      try {
        renderPage(doc, entry, resolveImageBuffer);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[pdf-renderer] Failed to render entry "${entry.id}" (${entry.kind}): ${message}`,
        );
        doc
          .fillColor('#CC0000')
          .font(FONT_REGULAR_NAME)
          .fontSize(8)
          .text(`[Render error: entry ${entry.id}]`, 10, 10, { width: PAGE_PT - 20 });
      }
    }

    doc.end();
  });
}
