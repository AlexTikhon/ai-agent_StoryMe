/**
 * Phase 2I — Local PDF render script
 *
 * Usage:
 *   pnpm --filter @book/api render:pdf
 *
 * Output:
 *   tmp/storyme-sample.pdf   (relative to apps/api/)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderStorybookPdf } from '../src/pdf/pdf-renderer';
import type { BookLayout } from '@book/types';

const BASE_CANVAS = { width: 2400, height: 2400, unit: 'px' as const };
const BASE_SAFE = { x: 180, y: 180, width: 2040, height: 2040 };

const SAMPLE_LAYOUT: BookLayout = {
  status: 'complete',
  trimSize: 'square_8x8',
  metadata: {
    title: "Mia's Friendship Adventure",
    childName: 'Mia',
    totalPages: 6,
    generatedAt: '1970-01-01T00:00:00.000Z',
  },
  entries: [
    // ── Cover ───────────────────────────────────────────────────────────────
    {
      id: 'sample-cover',
      kind: 'cover',
      template: 'cover_full_bleed',
      trimSize: 'square_8x8',
      canvas: BASE_CANVAS,
      safeArea: BASE_SAFE,
      bleed: 90,
      imageBlock: {
        box: { x: 0, y: 0, width: 2400, height: 2400 },
        imageUrl: '/mock-images/sample/cover.svg',
        altText: "Cover illustration for Mia's Friendship Adventure",
        objectFit: 'cover',
      },
      textBlock: {
        box: { x: 180, y: 1620, width: 2040, height: 600 },
        text: "Mia's Friendship Adventure",
        fontFamily: 'Fraunces',
        fontSize: 32,
        lineHeight: 1.2,
        align: 'center',
        verticalAlign: 'bottom',
        color: '#FFFFFF',
      },
      notes: ['Full-bleed cover image; title overlaid at bottom within safe area'],
    },

    // ── Page 1 — image_top_text_bottom ──────────────────────────────────────
    {
      id: 'sample-page-1',
      kind: 'page',
      pageNumber: 1,
      template: 'image_top_text_bottom',
      trimSize: 'square_8x8',
      canvas: BASE_CANVAS,
      safeArea: BASE_SAFE,
      bleed: 90,
      imageBlock: {
        box: { x: 180, y: 180, width: 2040, height: 1210 },
        imageUrl: '/mock-images/sample/page-1.svg',
        altText: 'Mia discovering a glowing light in the garden',
        objectFit: 'cover',
      },
      textBlock: {
        box: { x: 180, y: 1420, width: 2040, height: 800 },
        text: 'One sunny morning, Mia discovered something magical that would change everything. It all began with Mia discovering a glowing light in the garden. Mia knew deep down: Through friendship, we learn the importance of courage, kindness, and believing in ourselves.',
        fontFamily: 'Plus Jakarta Sans',
        fontSize: 18,
        lineHeight: 1.5,
        align: 'left',
        verticalAlign: 'top',
        color: '#1C1917',
      },
      notes: ['Template: image_top_text_bottom'],
    },

    // ── Page 2 — text_left_image_right ──────────────────────────────────────
    {
      id: 'sample-page-2',
      kind: 'page',
      pageNumber: 2,
      template: 'text_left_image_right',
      trimSize: 'square_8x8',
      canvas: BASE_CANVAS,
      safeArea: BASE_SAFE,
      bleed: 90,
      textBlock: {
        box: { x: 180, y: 180, width: 855, height: 2040 },
        text: 'Mia thought about friendship and took another brave step forward. The story continued as curiosity to excitement filled the air. Mia knew deep down: Through friendship, we learn the importance of courage.',
        fontFamily: 'Plus Jakarta Sans',
        fontSize: 18,
        lineHeight: 1.5,
        align: 'left',
        verticalAlign: 'top',
        color: '#1C1917',
      },
      imageBlock: {
        box: { x: 1065, y: 180, width: 1155, height: 2040 },
        imageUrl: '/mock-images/sample/page-2.svg',
        altText: 'Mia and friend walking through colorful mushrooms',
        objectFit: 'cover',
      },
      notes: ['Template: text_left_image_right'],
    },

    // ── Page 3 — image_left_text_right ──────────────────────────────────────
    {
      id: 'sample-page-3',
      kind: 'page',
      pageNumber: 3,
      template: 'image_left_text_right',
      trimSize: 'square_8x8',
      canvas: BASE_CANVAS,
      safeArea: BASE_SAFE,
      bleed: 90,
      imageBlock: {
        box: { x: 180, y: 180, width: 1230, height: 2040 },
        imageUrl: '/mock-images/sample/page-3.svg',
        altText: 'Mia and friend enter the forest',
        objectFit: 'cover',
      },
      textBlock: {
        box: { x: 1440, y: 180, width: 780, height: 2040 },
        text: 'Mia thought about friendship and took another brave step forward. They faced a small challenge and overcame it with courage and kindness.',
        fontFamily: 'Plus Jakarta Sans',
        fontSize: 18,
        lineHeight: 1.5,
        align: 'left',
        verticalAlign: 'top',
        color: '#1C1917',
      },
      notes: ['Template: image_left_text_right'],
    },

    // ── Page 4 — image_top_text_bottom ──────────────────────────────────────
    {
      id: 'sample-page-4',
      kind: 'page',
      pageNumber: 4,
      template: 'image_top_text_bottom',
      trimSize: 'square_8x8',
      canvas: BASE_CANVAS,
      safeArea: BASE_SAFE,
      bleed: 90,
      imageBlock: {
        box: { x: 180, y: 180, width: 2040, height: 1210 },
        imageUrl: '/mock-images/sample/page-4.svg',
        altText: 'Mia shares the story with family',
        objectFit: 'cover',
      },
      textBlock: {
        box: { x: 180, y: 1420, width: 2040, height: 800 },
        text: 'Mia thought about friendship and took another brave step forward. It all began with Mia sharing the story with her family. Together they celebrated the joy of their adventure.',
        fontFamily: 'Plus Jakarta Sans',
        fontSize: 18,
        lineHeight: 1.5,
        align: 'left',
        verticalAlign: 'top',
        color: '#1C1917',
      },
      notes: ['Template: image_top_text_bottom'],
    },

    // ── Page 5 — text_left_image_right ──────────────────────────────────────
    {
      id: 'sample-page-5',
      kind: 'page',
      pageNumber: 5,
      template: 'text_left_image_right',
      trimSize: 'square_8x8',
      canvas: BASE_CANVAS,
      safeArea: BASE_SAFE,
      bleed: 90,
      textBlock: {
        box: { x: 180, y: 180, width: 855, height: 2040 },
        text: 'Mia thought about friendship and took another brave step forward. The story continued as pride and happiness filled the air. Mia knew deep down: kindness is the greatest adventure.',
        fontFamily: 'Plus Jakarta Sans',
        fontSize: 18,
        lineHeight: 1.5,
        align: 'left',
        verticalAlign: 'top',
        color: '#1C1917',
      },
      imageBlock: {
        box: { x: 1065, y: 180, width: 1155, height: 2040 },
        imageUrl: '/mock-images/sample/page-5.svg',
        altText: 'A final magical moment',
        objectFit: 'cover',
      },
      notes: ['Template: text_left_image_right'],
    },

    // ── Page 6 — image_left_text_right ──────────────────────────────────────
    {
      id: 'sample-page-6',
      kind: 'page',
      pageNumber: 6,
      template: 'image_left_text_right',
      trimSize: 'square_8x8',
      canvas: BASE_CANVAS,
      safeArea: BASE_SAFE,
      bleed: 90,
      imageBlock: {
        box: { x: 180, y: 180, width: 1230, height: 2040 },
        imageUrl: '/mock-images/sample/page-6.svg',
        altText: 'Mia hugging family with a big smile',
        objectFit: 'cover',
      },
      textBlock: {
        box: { x: 1440, y: 180, width: 780, height: 2040 },
        text: 'Mia returned home with a heart full of joy, knowing that every adventure begins with a single brave step. The end.',
        fontFamily: 'Plus Jakarta Sans',
        fontSize: 18,
        lineHeight: 1.5,
        align: 'left',
        verticalAlign: 'top',
        color: '#1C1917',
      },
      notes: ['Template: image_left_text_right'],
    },

    // ── Back cover ───────────────────────────────────────────────────────────
    {
      id: 'sample-back-cover',
      kind: 'back_cover',
      template: 'back_cover_summary',
      trimSize: 'square_8x8',
      canvas: BASE_CANVAS,
      safeArea: BASE_SAFE,
      bleed: 90,
      imageBlock: {
        box: { x: 0, y: 0, width: 2400, height: 2400 },
        imageUrl: '/mock-images/sample/back-cover.svg',
        altText: 'Back cover illustration',
        objectFit: 'cover',
      },
      textBlock: {
        box: { x: 300, y: 600, width: 1800, height: 1200 },
        text: "The End! We hope Mia enjoyed this adventure. Keep exploring, keep dreaming!\n\nThrough friendship, we learn the importance of courage, kindness, and believing in ourselves.",
        fontFamily: 'Plus Jakarta Sans',
        fontSize: 16,
        lineHeight: 1.6,
        align: 'center',
        verticalAlign: 'middle',
        color: '#FFFFFF',
      },
      notes: ['Back cover uses full-bleed image; summary text overlaid at center'],
    },
  ],
};

async function main(): Promise<void> {
  const outDir = resolve(__dirname, '../tmp');
  const outPath = resolve(outDir, 'storyme-sample.pdf');

  console.log('Rendering storybook PDF...');
  const buffer = await renderStorybookPdf(SAMPLE_LAYOUT);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, buffer);

  const kb = (buffer.length / 1024).toFixed(1);
  console.log(`Done. ${buffer.length} bytes (${kb} KB)`);
  console.log(`Output: ${outPath}`);
}

main().catch((err: unknown) => {
  console.error('PDF render failed:', err);
  process.exit(1);
});
