import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { validateImage } from './validated-image';
import { generateMockImagePng } from './mock-image-producer';

describe('bounded raster validation', () => {
  it('decodes real PNG/JPEG and retains a checksum', async () => {
    const png = generateMockImagePng('valid');
    expect(await validateImage(png)).toMatchObject({
      format: 'png',
      sizeBytes: png.length,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await validateImage(await sharp(png).jpeg().toBuffer())).toMatchObject({
      format: 'jpeg',
    });
  });
  it('rejects arbitrary nonempty, truncated, and oversized input', async () => {
    const png = generateMockImagePng('valid');
    for (const bytes of [
      Buffer.from('not an image'),
      png.subarray(0, 40),
      Buffer.alloc(20 * 1024 * 1024 + 1),
    ]) {
      expect(await validateImage(bytes)).toBeNull();
    }
  });
});
