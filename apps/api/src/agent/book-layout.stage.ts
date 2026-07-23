import { AgentStep } from '@prisma/client';
import type { BookLayout, BookLayoutEntry, BookPreview, ImageGenerationResult } from '@book/types';
import type { GenerationStage } from './generation-stage';

const LAYOUT_CANVAS = { width: 2400, height: 2400, unit: 'px' as const };
const LAYOUT_SAFE_AREA = { x: 180, y: 180, width: 2040, height: 2040 };
const LAYOUT_BLEED = 90;
const LAYOUT_DISPLAY_FONT = 'Fraunces';
const LAYOUT_BODY_FONT = 'Plus Jakarta Sans';

/**
 * Every story page uses this single stable template: image on top, story
 * text below, consistent margins/font sizes.
 */
const PAGE_IMAGE_BOX = { x: 180, y: 180, width: 2040, height: 1210 };
const PAGE_TEXT_BOX = { x: 180, y: 1420, width: 2040, height: 800 };

export interface BookLayoutStageInput {
  readonly bookId: string;
  readonly bookPreview: BookPreview;
  readonly imageGenerationResult: ImageGenerationResult;
}

export class BookLayoutStage implements GenerationStage<BookLayoutStageInput, BookLayout> {
  readonly step = AgentStep.layout;

  execute({ bookId, bookPreview, imageGenerationResult }: BookLayoutStageInput): BookLayout {
    const entries: BookLayoutEntry[] = [];

    const coverImage = imageGenerationResult.images.find((image) => image.kind === 'cover');
    entries.push({
      id: `${bookId}-layout-cover`,
      kind: 'cover',
      template: 'cover_full_bleed',
      trimSize: 'square_8x8',
      canvas: LAYOUT_CANVAS,
      safeArea: LAYOUT_SAFE_AREA,
      bleed: LAYOUT_BLEED,
      ...(coverImage
        ? {
            imageBlock: {
              box: { x: 0, y: 0, width: 2400, height: 2400 },
              imageUrl: coverImage.imageUrl,
              altText: coverImage.altText,
              objectFit: 'cover' as const,
            },
          }
        : {}),
      textBlock: {
        box: { x: 180, y: 1620, width: 2040, height: 600 },
        text: bookPreview.cover.title,
        fontFamily: LAYOUT_DISPLAY_FONT,
        fontSize: 32,
        lineHeight: 1.2,
        align: 'center',
        verticalAlign: 'bottom',
        color: '#FFFFFF',
      },
      notes: ['Full-bleed cover image; title overlaid at bottom within safe area'],
    });

    for (const page of bookPreview.pages) {
      const pageImage = imageGenerationResult.images.find(
        (image) => image.kind === 'page' && image.pageNumber === page.pageNumber,
      );

      if (!pageImage) {
        entries.push({
          id: `${bookId}-layout-page-${page.pageNumber}`,
          kind: 'page',
          pageNumber: page.pageNumber,
          template: 'text_only',
          trimSize: 'square_8x8',
          canvas: LAYOUT_CANVAS,
          safeArea: LAYOUT_SAFE_AREA,
          bleed: LAYOUT_BLEED,
          textBlock: {
            box: { x: 180, y: 180, width: 2040, height: 2040 },
            text: page.text,
            fontFamily: LAYOUT_BODY_FONT,
            fontSize: 20,
            lineHeight: 1.6,
            align: 'left',
            verticalAlign: 'top',
            color: '#1C1917',
          },
          notes: ['Template: text_only (no image available for this page)'],
        });
        continue;
      }

      entries.push({
        id: `${bookId}-layout-page-${page.pageNumber}`,
        kind: 'page',
        pageNumber: page.pageNumber,
        template: 'image_top_text_bottom',
        trimSize: 'square_8x8',
        canvas: LAYOUT_CANVAS,
        safeArea: LAYOUT_SAFE_AREA,
        bleed: LAYOUT_BLEED,
        imageBlock: {
          box: PAGE_IMAGE_BOX,
          imageUrl: pageImage.imageUrl,
          altText: pageImage.altText,
          objectFit: 'cover',
        },
        textBlock: {
          box: PAGE_TEXT_BOX,
          text: page.text,
          fontFamily: LAYOUT_BODY_FONT,
          fontSize: 18,
          lineHeight: 1.5,
          align: 'left',
          verticalAlign: 'top',
          color: '#1C1917',
        },
        notes: ['Template: image_top_text_bottom'],
      });
    }

    const backImage = imageGenerationResult.images.find((image) => image.kind === 'back_cover');
    entries.push({
      id: `${bookId}-layout-back-cover`,
      kind: 'back_cover',
      template: 'back_cover_summary',
      trimSize: 'square_8x8',
      canvas: LAYOUT_CANVAS,
      safeArea: LAYOUT_SAFE_AREA,
      bleed: LAYOUT_BLEED,
      ...(backImage
        ? {
            imageBlock: {
              box: { x: 0, y: 0, width: 2400, height: 2400 },
              imageUrl: backImage.imageUrl,
              altText: backImage.altText,
              objectFit: 'cover' as const,
            },
          }
        : {}),
      textBlock: {
        box: { x: 300, y: 600, width: 1800, height: 1200 },
        text: `${bookPreview.backCover.message}\n\n${bookPreview.backCover.educationalSummary}`,
        fontFamily: LAYOUT_BODY_FONT,
        fontSize: 16,
        lineHeight: 1.6,
        align: 'center',
        verticalAlign: 'middle',
        color: '#FFFFFF',
      },
      notes: ['Back cover uses full-bleed image; summary text overlaid at center'],
    });

    return {
      status: 'complete',
      trimSize: 'square_8x8',
      entries,
      metadata: {
        title: bookPreview.title,
        childName: bookPreview.cover.childName,
        totalPages: bookPreview.pages.length,
        generatedAt: '1970-01-01T00:00:00.000Z',
      },
    };
  }
}

export const bookLayoutStage = new BookLayoutStage();
