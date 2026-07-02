import { describe, it, expect } from 'vitest';
import { generateMockImagePng } from './mock-image-producer';

describe('generateMockImagePng', () => {
  it('returns a non-empty buffer', () => {
    const buf = generateMockImagePng('book-1:cover:0');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('returns a valid PNG (correct signature)', () => {
    const buf = generateMockImagePng('book-1:cover:0');
    expect(buf.slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('produces byte-identical output for the same seed', () => {
    const a = generateMockImagePng('book-1:page:3');
    const b = generateMockImagePng('book-1:page:3');
    expect(a.equals(b)).toBe(true);
  });

  it('produces different output for different seeds', () => {
    const a = generateMockImagePng('book-1:cover:0');
    const b = generateMockImagePng('book-1:back_cover:0');
    expect(a.equals(b)).toBe(false);
  });

  it('stays small (a tiny color swatch, not real artwork)', () => {
    const buf = generateMockImagePng('book-1:cover:0');
    expect(buf.length).toBeLessThan(200);
  });
});
