import { BadRequestException, Injectable } from '@nestjs/common';
import sharp from 'sharp';
import type { AllowedChildPhotoMimeType } from '../books/child-photo.constants';

/**
 * Total decoded pixel count (width * height) a child photo may have —
 * generous for any real camera/phone photo, but small enough that decoding
 * it can't be used as a memory-exhaustion vector. Enforced at decode time via
 * sharp's own `limitInputPixels`, so an oversized image is rejected before
 * its full pixel buffer is ever allocated.
 */
export const MAX_CHILD_PHOTO_PIXELS = 4096 * 4096;

const FORMAT_TO_CONTENT_TYPE: Record<string, AllowedChildPhotoMimeType> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export interface ProcessedChildPhoto {
  buffer: Buffer;
  contentType: AllowedChildPhotoMimeType;
}

/**
 * Turns an untrusted uploaded buffer into a safe-to-store child reference
 * photo. Never trusts the client-supplied Content-Type/mimetype (multer's
 * fileFilter only checked that header, which is trivially spoofable) —
 * decodes the bytes with sharp/libvips instead, which validates real magic
 * bytes/container structure and throws on anything it can't actually decode
 * as an image.
 *
 * Re-encoding (rather than passing the original bytes through) is what
 * strips EXIF/ICC/XMP metadata — including GPS location tags a photo can
 * carry — since sharp does not copy source metadata to its output unless
 * `.withMetadata()` is explicitly requested, which this never does.
 */
@Injectable()
export class ChildPhotoProcessor {
  async process(buffer: Buffer): Promise<ProcessedChildPhoto> {
    let image: ReturnType<typeof sharp>;
    let metadata: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
    try {
      image = sharp(buffer, { limitInputPixels: MAX_CHILD_PHOTO_PIXELS });
      metadata = await image.metadata();
    } catch {
      throw new BadRequestException(
        'The uploaded file could not be decoded as an image, or exceeds the maximum allowed dimensions',
      );
    }

    const contentType = metadata.format ? FORMAT_TO_CONTENT_TYPE[metadata.format] : undefined;
    if (!contentType) {
      throw new BadRequestException('Unsupported image format — use jpg, png, or webp');
    }

    // .rotate() with no argument auto-orients from EXIF Orientation *before*
    // that tag (and every other EXIF/ICC/XMP field) is dropped by re-encoding
    // without .withMetadata() — the photo looks right-side-up with no
    // metadata surviving into the stored bytes.
    const oriented = image.rotate();
    const reencoded =
      contentType === 'image/jpeg'
        ? oriented.jpeg()
        : contentType === 'image/png'
          ? oriented.png()
          : oriented.webp();

    const processedBuffer = await reencoded.toBuffer();
    return { buffer: processedBuffer, contentType };
  }
}
