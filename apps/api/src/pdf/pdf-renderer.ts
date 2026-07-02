import PDFDocument from 'pdfkit';
import type { BookLayout, BookLayoutEntry, LayoutTextBlock } from '@book/types';

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
 */
function resolveFont(fontFamily: string, isDisplay: boolean): string {
  const f = fontFamily.toLowerCase();
  const isSerif =
    f.includes('fraunces') || f.includes('lora') || f.includes('georgia') || f.includes('serif');
  if (isSerif) return isDisplay ? 'Times-Bold' : 'Times-Roman';
  return isDisplay ? 'Helvetica-Bold' : 'Helvetica';
}

function renderTextBlock(
  doc: PDFKit.PDFDocument,
  tb: LayoutTextBlock,
  isDisplay: boolean,
): void {
  const x = pt(tb.box.x);
  const y = pt(tb.box.y);
  const w = Math.max(pt(tb.box.width), 1);
  const h = Math.max(pt(tb.box.height), 1);

  doc
    .font(resolveFont(tb.fontFamily, isDisplay))
    .fontSize(tb.fontSize)
    .fillColor(tb.color)
    .text(tb.text, x, y, {
      width: w,
      height: h,
      align: tb.align as 'left' | 'center' | 'right',
      lineGap: Math.max((tb.lineHeight - 1) * tb.fontSize, 0),
    });
}

function renderPage(doc: PDFKit.PDFDocument, entry: BookLayoutEntry): void {
  // Page background
  doc.rect(0, 0, PAGE_PT, PAGE_PT).fill('#F9F6F2');

  // Image block — rendered as a labelled placeholder rectangle
  if (entry.imageBlock) {
    const { box, altText } = entry.imageBlock;
    const x = pt(box.x);
    const y = pt(box.y);
    const w = Math.max(pt(box.width), 1);
    const h = Math.max(pt(box.height), 1);

    doc.rect(x, y, w, h).fillAndStroke('#D4C4B4', '#B0998A');

    const label =
      altText.length > 0
        ? altText
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
 * Images are rendered as labelled placeholder rectangles since the pipeline
 * currently produces local mock SVGs that cannot be embedded in PDF.
 *
 * Font sizes from the layout are used as PDF points directly (not scaled by SCALE).
 * Coordinate boxes are scaled from the 2400 px canvas to 576 pt PDF page.
 */
export function renderStorybookPdf(layout: BookLayout): Promise<Buffer> {
  if (layout.entries.length === 0) {
    return Promise.reject(new Error('Cannot render PDF: book has no layout entries'));
  }

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
        renderPage(doc, entry);
      } catch {
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
