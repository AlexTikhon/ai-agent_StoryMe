import '@/test-support/fixture-api-base';
import { describe, it, expect } from 'vitest';
import { resolveAssetUrl } from './asset-url';

describe('resolveAssetUrl', () => {
  it('returns null for null', () => {
    expect(resolveAssetUrl(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(resolveAssetUrl(undefined)).toBeNull();
  });

  it('returns an absolute https URL unchanged', () => {
    const url = 'https://cdn.example.com/books/abc/storybook.pdf';
    expect(resolveAssetUrl(url)).toBe(url);
  });

  it('returns an absolute http URL unchanged', () => {
    const url = 'http://cdn.example.com/books/abc/storybook.pdf';
    expect(resolveAssetUrl(url)).toBe(url);
  });

  it('resolves a relative path against the API origin (strips /api prefix)', () => {
    const result = resolveAssetUrl('/files/books/book-1/storybook.pdf');
    expect(result).toBe('http://localhost:4000/files/books/book-1/storybook.pdf');
  });

  it('resolves a relative path with different bookId', () => {
    const result = resolveAssetUrl('/files/books/abc-123/storybook.pdf');
    expect(result).toBe('http://localhost:4000/files/books/abc-123/storybook.pdf');
  });
});
