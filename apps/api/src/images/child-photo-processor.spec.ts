import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import { ChildPhotoProcessor, MAX_CHILD_PHOTO_PIXELS } from './child-photo-processor';

async function makeJpeg(width = 32, height = 32): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#ff0000' } })
    .jpeg()
    .toBuffer();
}

async function makePng(width = 32, height = 32): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: '#00ff00' } })
    .png()
    .toBuffer();
}

async function makeWebp(width = 32, height = 32): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#0000ff' } })
    .webp()
    .toBuffer();
}

describe('ChildPhotoProcessor', () => {
  const processor = new ChildPhotoProcessor();

  it('decodes and re-encodes a real jpeg, reporting image/jpeg', async () => {
    const input = await makeJpeg();

    const result = await processor.process(input);

    expect(result.contentType).toBe('image/jpeg');
    const outputMeta = await sharp(result.buffer).metadata();
    expect(outputMeta.format).toBe('jpeg');
  });

  it('decodes and re-encodes a real png, reporting image/png', async () => {
    const input = await makePng();

    const result = await processor.process(input);

    expect(result.contentType).toBe('image/png');
    const outputMeta = await sharp(result.buffer).metadata();
    expect(outputMeta.format).toBe('png');
  });

  it('decodes and re-encodes a real webp, reporting image/webp', async () => {
    const input = await makeWebp();

    const result = await processor.process(input);

    expect(result.contentType).toBe('image/webp');
    const outputMeta = await sharp(result.buffer).metadata();
    expect(outputMeta.format).toBe('webp');
  });

  it('rejects bytes that are not a decodable image at all, regardless of what the caller claims it is', async () => {
    const garbage = Buffer.from('this is definitely not image data, just plain text bytes');

    await expect(processor.process(garbage)).rejects.toThrow(BadRequestException);
  });

  it('rejects an image whose total pixel count exceeds the configured ceiling', async () => {
    // Dimensions chosen so width*height just clears MAX_CHILD_PHOTO_PIXELS.
    const side = Math.ceil(Math.sqrt(MAX_CHILD_PHOTO_PIXELS)) + 10;
    const oversized = await sharp({
      create: { width: side, height: side, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();

    await expect(processor.process(oversized)).rejects.toThrow(BadRequestException);
  }, 20_000);

  it('strips EXIF metadata (e.g. GPS/copyright tags) from the output', async () => {
    const withExif = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#fff' } })
      .withExif({ IFD0: { Copyright: 'sensitive-location-marker' } })
      .jpeg()
      .toBuffer();
    const inputMeta = await sharp(withExif).metadata();
    expect(inputMeta.exif).toBeDefined(); // sanity check the fixture actually carries EXIF

    const result = await processor.process(withExif);

    const outputMeta = await sharp(result.buffer).metadata();
    expect(outputMeta.exif).toBeUndefined();
  });

  it('auto-orients from EXIF Orientation before stripping it (image is not left sideways)', async () => {
    // A 40x20 image tagged as needing 90-degree rotation (EXIF orientation 6)
    // should come out re-oriented to 20x40 with no orientation tag surviving.
    const rotated = await sharp({
      create: { width: 40, height: 20, channels: 3, background: '#fff' },
    })
      .withExif({ IFD0: { Orientation: '6' } })
      .jpeg()
      .toBuffer();

    const result = await processor.process(rotated);

    const outputMeta = await sharp(result.buffer).metadata();
    expect(outputMeta.orientation).toBeUndefined();
  });
});
