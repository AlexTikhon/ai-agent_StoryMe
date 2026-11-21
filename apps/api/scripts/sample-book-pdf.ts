/**
 * Offline builder for the public sample book's bundled PDF.
 *
 * The canonical content lives in apps/web/src/sample-book/sample-book.json and
 * the illustrations in apps/web/public/sample-book/. This module reads them from
 * disk (it is never imported by the web app), rasterizes the SVGs with sharp and
 * renders the six pages with the production PDFKit renderer. It needs no
 * database, Redis, credentials or provider calls.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { z } from 'zod';
import type { BookLayout, BookLayoutEntry, LayoutTextBlock } from '@book/types';
import { renderStorybookPdf } from '../src/pdf/pdf-renderer';

const WEB_ROOT = resolve(__dirname, '..', '..', 'web');
export const SAMPLE_BOOK_FIXTURE_PATH = resolve(WEB_ROOT, 'src', 'sample-book', 'sample-book.json');
export const WEB_PUBLIC_DIR = resolve(WEB_ROOT, 'public');

/** Prefix of the PDF Keywords entry that records which inputs produced the file. */
export const FINGERPRINT_PREFIX = 'storyme-sample-fixture-sha256:';

const FONT_DIR = resolve(__dirname, '..', 'assets', 'fonts');
const FONT_REGULAR_PATH = resolve(FONT_DIR, 'NotoSans-Regular.ttf');
const FONT_BOLD_PATH = resolve(FONT_DIR, 'NotoSans-Bold.ttf');

const STORY_PAGE_COUNT = 4;
const ASSET_PREFIX = '/sample-book/';

const illustrationSchema = z.object({
  src: z
    .string()
    .regex(/^\/sample-book\/[a-z0-9-]+\.svg$/, 'illustration src must be /sample-book/<name>.svg'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  alt: z.string().trim().min(20, 'illustration alt text must describe the scene'),
});

const fixtureSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().trim().min(1),
    childName: z.string().trim().min(1),
    readingAge: z.string().trim().min(1),
    provenance: z.string().trim().min(1),
    cover: z.object({ illustration: illustrationSchema }),
    pages: z
      .array(
        z.object({
          pageNumber: z.number().int().positive(),
          heading: z.string().trim().min(1),
          text: z.string().trim().min(1),
          illustration: illustrationSchema,
        }),
      )
      .length(STORY_PAGE_COUNT, `the sample book has exactly ${STORY_PAGE_COUNT} story pages`),
    backCover: z.object({ text: z.string().trim().min(1), illustration: illustrationSchema }),
    pdf: z.object({
      href: z
        .string()
        .regex(/^\/sample-book\/[a-z0-9-]+\.pdf$/, 'pdf href must be /sample-book/<name>.pdf'),
      pageCount: z.number().int(),
    }),
  })
  .superRefine((book, ctx) => {
    book.pages.forEach((page, index) => {
      if (page.pageNumber !== index + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pages', index, 'pageNumber'],
          message: `story pages must be numbered 1..${STORY_PAGE_COUNT} in order`,
        });
      }
    });
    if (book.pdf.pageCount !== book.pages.length + 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pdf', 'pageCount'],
        message: 'pdf.pageCount must equal cover + story pages + back cover',
      });
    }
    const sources = illustrationsOf(book).map((illustration) => illustration.src);
    if (new Set(sources).size !== sources.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pages'],
        message: 'every page needs its own illustration',
      });
    }
  });

export type SampleBookFixture = z.infer<typeof fixtureSchema>;
type Illustration = z.infer<typeof illustrationSchema>;

export function parseSampleBookFixture(raw: string): SampleBookFixture {
  return fixtureSchema.parse(JSON.parse(raw));
}

/** Illustrations in reading order: cover, story pages, back cover. */
export function illustrationsOf(
  book: Pick<SampleBookFixture, 'cover' | 'pages' | 'backCover'>,
): Illustration[] {
  return [
    book.cover.illustration,
    ...book.pages.map((page) => page.illustration),
    book.backCover.illustration,
  ];
}

/** Maps a /sample-book/... URL to its file under apps/web/public, refusing anything outside it. */
export function resolvePublicAsset(href: string, publicDir: string = WEB_PUBLIC_DIR): string {
  if (!href.startsWith(ASSET_PREFIX))
    throw new Error(`Sample asset outside ${ASSET_PREFIX}: ${href}`);
  const path = resolve(publicDir, `.${href}`);
  const rel = relative(resolve(publicDir, 'sample-book'), path);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new Error(`Sample asset escapes public dir: ${href}`);
  return path;
}

/** The text drawn on the back cover: the closing line, then the honest provenance note. */
export function backCoverText(book: SampleBookFixture): string {
  return `${book.backCover.text}\n\n${book.provenance}`;
}

/**
 * Hash of everything that shapes the PDF: the parsed fixture (independent of
 * whitespace/line endings) and each SVG in reading order (line endings
 * normalized, so a Windows checkout produces the same value).
 */
export function fingerprintSampleInputs(
  book: SampleBookFixture,
  svgs: ReadonlyArray<{ src: string; content: string }>,
): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(book));
  for (const svg of svgs) {
    hash.update(`\n--${svg.src}--\n`);
    hash.update(svg.content.replace(/\r\n/g, '\n'));
  }
  return hash.digest('hex');
}

const CANVAS = { width: 2400, height: 2400, unit: 'px' as const };
const SAFE_AREA = { x: 180, y: 180, width: 2040, height: 2040 };
const COMMON = { trimSize: 'square_8x8' as const, canvas: CANVAS, safeArea: SAFE_AREA, bleed: 90 };

/** Builds the six-entry layout (cover, four story pages, back cover) from the fixture. */
export function buildSampleBookLayout(book: SampleBookFixture): BookLayout {
  const cover: BookLayoutEntry = {
    ...COMMON,
    id: 'sample-cover',
    kind: 'cover',
    template: 'cover_full_bleed',
    imageBlock: {
      box: { x: 0, y: 0, width: 2400, height: 2400 },
      imageUrl: book.cover.illustration.src,
      altText: book.cover.illustration.alt,
      objectFit: 'cover',
    },
    textBlock: {
      box: { x: 180, y: 1880, width: 2040, height: 340 },
      text: book.title,
      fontFamily: 'Fraunces',
      fontSize: 34,
      lineHeight: 1.2,
      align: 'center',
      verticalAlign: 'middle',
      color: '#FFFFFF',
    },
    notes: ['Curated sample: full-bleed cover, title over the grass below the scene'],
  };

  const pages: BookLayoutEntry[] = book.pages.map((page) => ({
    ...COMMON,
    id: `sample-page-${page.pageNumber}`,
    kind: 'page',
    pageNumber: page.pageNumber,
    template: 'image_top_text_bottom',
    imageBlock: {
      box: { x: 180, y: 180, width: 2040, height: 1210 },
      imageUrl: page.illustration.src,
      altText: page.illustration.alt,
      objectFit: 'cover',
    },
    textBlock: {
      box: { x: 180, y: 1450, width: 2040, height: 740 },
      text: page.text,
      fontFamily: 'Plus Jakarta Sans',
      fontSize: 17,
      lineHeight: 1.5,
      align: 'left',
      verticalAlign: 'top',
      color: '#1C1917',
    },
    notes: [`Curated sample page: ${page.heading}`],
  }));

  const back: BookLayoutEntry = {
    ...COMMON,
    id: 'sample-back-cover',
    kind: 'back_cover',
    template: 'back_cover_summary',
    imageBlock: {
      box: { x: 0, y: 0, width: 2400, height: 2400 },
      imageUrl: book.backCover.illustration.src,
      altText: book.backCover.illustration.alt,
      objectFit: 'cover',
    },
    textBlock: {
      box: { x: 240, y: 180, width: 1920, height: 900 },
      text: backCoverText(book),
      fontFamily: 'Plus Jakarta Sans',
      fontSize: 15,
      lineHeight: 1.5,
      align: 'center',
      verticalAlign: 'middle',
      color: '#FFFFFF',
    },
    notes: ['Curated sample: closing line and provenance over the night sky'],
  };

  return {
    status: 'complete',
    trimSize: 'square_8x8',
    metadata: {
      title: book.title,
      childName: book.childName,
      totalPages: book.pages.length,
      generatedAt: '1970-01-01T00:00:00.000Z',
    },
    entries: [cover, ...pages, back],
  };
}

const PT_PER_PX = 576 / 2400;

/**
 * The production renderer silently shrinks (and at worst truncates) text that
 * does not fit its box. A curated sample must never ship shrunk or clipped
 * text, so this measures every block at its requested size with the same
 * embedded fonts and throws if any would need shrinking.
 */
export function assertSampleTextFits(layout: BookLayout): void {
  const doc = new PDFDocument({ autoFirstPage: false });
  doc.registerFont('regular', FONT_REGULAR_PATH);
  doc.registerFont('bold', FONT_BOLD_PATH);
  for (const entry of layout.entries) {
    const tb: LayoutTextBlock | undefined = entry.textBlock;
    if (!tb) continue;
    const display = entry.kind === 'cover' || entry.kind === 'back_cover';
    doc.font(display ? 'bold' : 'regular').fontSize(tb.fontSize);
    const height = doc.heightOfString(tb.text, {
      width: tb.box.width * PT_PER_PX,
      lineGap: Math.max((tb.lineHeight - 1) * tb.fontSize, 0),
    });
    const available = tb.box.height * PT_PER_PX;
    if (height > available) {
      throw new Error(
        `Sample text for "${entry.id}" needs ${height.toFixed(1)}pt but its box is ${available.toFixed(1)}pt; shorten the fixture text.`,
      );
    }
  }
}

/** Raster width per image box: ~225 dpi on the 8 in page, enough for print and small on disk. */
function rasterWidth(boxWidthPx: number): number {
  return Math.round(boxWidthPx * 0.75);
}

export interface RenderedSampleBook {
  buffer: Buffer;
  fingerprint: string;
  layout: BookLayout;
  book: SampleBookFixture;
}

export interface RenderSampleBookInput {
  fixtureRaw: string;
  /** Returns the SVG source for a /sample-book/... URL; throws if it is missing. */
  readSvg: (src: string) => string;
}

export async function renderSampleBookPdf({
  fixtureRaw,
  readSvg,
}: RenderSampleBookInput): Promise<RenderedSampleBook> {
  const book = parseSampleBookFixture(fixtureRaw);
  const layout = buildSampleBookLayout(book);
  assertSampleTextFits(layout);

  const svgs = illustrationsOf(book).map((illustration) => ({
    src: illustration.src,
    content: readSvg(illustration.src),
  }));
  const fingerprint = fingerprintSampleInputs(book, svgs);

  const rasters = new Map<string, Buffer>();
  for (const entry of layout.entries) {
    const block = entry.imageBlock;
    if (!block) continue;
    const svg = svgs.find((candidate) => candidate.src === block.imageUrl);
    if (!svg) throw new Error(`No SVG loaded for ${block.imageUrl}`);
    const png = await sharp(Buffer.from(svg.content), { density: 300 })
      .resize({ width: rasterWidth(block.box.width) })
      .flatten({ background: '#ffffff' })
      .png({ compressionLevel: 9 })
      .toBuffer();
    rasters.set(block.imageUrl, png);
  }

  const buffer = await renderStorybookPdf(layout, {
    strict: true,
    resolveImageBuffer: (block) => rasters.get(block.imageUrl),
    documentInfo: { Subject: book.provenance, Keywords: `${FINGERPRINT_PREFIX}${fingerprint}` },
  });
  return { buffer, fingerprint, layout, book };
}

/** Reads the canonical fixture and illustrations from the web package on disk. */
export function readSampleBookSources(publicDir: string = WEB_PUBLIC_DIR): RenderSampleBookInput {
  return {
    fixtureRaw: readFileSync(SAMPLE_BOOK_FIXTURE_PATH, 'utf8'),
    readSvg: (src) => readFileSync(resolvePublicAsset(src, publicDir), 'utf8'),
  };
}

/** Counts page objects in an uncompressed PDF (`/Type /Page`, not `/Pages`). */
export function countPdfPages(raw: string): number {
  return (raw.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
}

/** Reads a document-information string; PDFKit stores each value as an indirect object. */
export function readPdfInfoString(raw: string, key: string): string | undefined {
  const ref = new RegExp(`/${key} (\\d+) 0 R`).exec(raw);
  if (!ref) return undefined;
  return new RegExp(`\\n${ref[1]} 0 obj\\n\\((.*)\\)\\nendobj`)
    .exec(raw)?.[1]
    ?.replace(/\\([()\\])/g, '$1');
}
