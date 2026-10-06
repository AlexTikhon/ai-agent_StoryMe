import sharp from 'sharp';
import type { ImageAssetContentType } from './image-asset-storage';

/**
 * Bounding box for a library-card cover derivative. Roughly 2x the rendered
 * card width so it stays crisp on high-DPI screens while weighing a few tens
 * of kilobytes instead of the original multi-megabyte illustration.
 */
export const COVER_THUMBNAIL_MAX_WIDTH = 360;
export const COVER_THUMBNAIL_MAX_HEIGHT = 480;

/** Same decode-time memory guard the child-photo pipeline uses. */
const MAX_INPUT_PIXELS = 4096 * 4096;

export interface CoverThumbnail {
  buffer: Buffer;
  contentType: Extract<ImageAssetContentType, 'image/webp'>;
}

/** Storage key of the cover derivative that sits beside its immutable source image. */
export function coverThumbnailKey(coverKey: string): string {
  return `${coverKey}-thumb`;
}

/**
 * Downscales a published cover to a small WebP derivative. Returns null when
 * the source cannot or should not be rasterized (e.g. SVG, which is already
 * tiny and not worth decoding with an external-reference-capable renderer, or
 * bytes sharp cannot decode) so the caller can fall back to the original.
 * Metadata is dropped by re-encoding without `.withMetadata()`.
 */
export async function renderCoverThumbnail(source: Buffer): Promise<CoverThumbnail | null> {
  try {
    const image = sharp(source, { limitInputPixels: MAX_INPUT_PIXELS });
    const { format } = await image.metadata();
    if (format !== 'png' && format !== 'jpeg' && format !== 'webp') return null;
    const buffer = await image
      .rotate()
      .resize({
        width: COVER_THUMBNAIL_MAX_WIDTH,
        height: COVER_THUMBNAIL_MAX_HEIGHT,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 78 })
      .toBuffer();
    return { buffer, contentType: 'image/webp' };
  } catch {
    return null;
  }
}
