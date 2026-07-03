import { describe, it, expect } from 'vitest';
import { safePdfFilename } from './pdf-filename';

describe('safePdfFilename', () => {
  it('builds a lowercase hyphenated filename from the title', () => {
    expect(safePdfFilename("Emma's Story")).toBe('emma-s-story.pdf');
  });

  it('trims surrounding whitespace', () => {
    expect(safePdfFilename('  Adventure Time  ')).toBe('adventure-time.pdf');
  });

  it('replaces unsafe filename characters', () => {
    expect(safePdfFilename('Weird/Name:Test*?"<>|')).toBe('weird-name-test.pdf');
  });

  it('falls back to storyme-book.pdf when title is null', () => {
    expect(safePdfFilename(null)).toBe('storyme-book.pdf');
  });

  it('falls back to storyme-book.pdf when title is undefined', () => {
    expect(safePdfFilename(undefined)).toBe('storyme-book.pdf');
  });

  it('falls back to storyme-book.pdf when title is empty or whitespace-only', () => {
    expect(safePdfFilename('   ')).toBe('storyme-book.pdf');
  });

  it('falls back to storyme-book.pdf when title has no safe characters', () => {
    expect(safePdfFilename('???')).toBe('storyme-book.pdf');
  });

  it('always ends with .pdf', () => {
    expect(safePdfFilename('My Book')).toMatch(/\.pdf$/);
  });
});
