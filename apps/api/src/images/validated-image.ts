import sharp from 'sharp';
import { createHash } from 'node:crypto';

export interface ValidatedImage {
  sha256: string;
  sizeBytes: number;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
}

/** Decode the complete raster, with compressed-byte and decoded-pixel limits. */
export async function validateImage(
  buffer: Buffer | null | undefined,
): Promise<ValidatedImage | null> {
  if (!buffer || buffer.length === 0 || buffer.length > 20 * 1024 * 1024) return null;
  try {
    const decoder = sharp(buffer, { limitInputPixels: 16_777_216, failOn: 'warning' });
    const metadata = await decoder.metadata();
    if (metadata.format !== 'png' && metadata.format !== 'jpeg') return null;
    if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) return null;
    await decoder.raw().toBuffer();
    return {
      sha256: createHash('sha256').update(buffer).digest('hex'),
      sizeBytes: buffer.length,
      format: metadata.format,
      width: metadata.width,
      height: metadata.height,
    };
  } catch {
    return null;
  }
}
