import { BookStatus, SupportedLanguage, type BookDto, type BookPreview } from '@book/types';
import { describe, expect, it } from 'vitest';
import {
  hasPublishedBook,
  hasPublishedPdf,
  publishedVersionStatusMessage,
} from './publication-availability';

const preview: BookPreview = {
  title: 'A family story',
  subtitle: 'For Mia',
  cover: {
    title: 'A family story',
    subtitle: 'For Mia',
    childName: 'Mia',
    illustrationPrompt: 'A storybook cover',
  },
  pages: [
    {
      pageNumber: 1,
      title: 'Page one',
      text: 'Once upon a time.',
      illustrationPrompt: 'A storybook page',
      layout: 'image_top_text_bottom',
      learningGoal: 'Kindness',
    },
  ],
  backCover: { message: 'The end', educationalSummary: 'Kindness' },
  metadata: {
    language: 'en',
    theme: 'family',
    childAge: 5,
    totalPages: 1,
    generatedBy: 'LocalPipelineAgent',
  },
};

function book(status: BookStatus, published = true): BookDto {
  return {
    id: 'book-1',
    userId: 'user-1',
    title: 'A family story',
    childName: 'Mia',
    childAge: 5,
    language: SupportedLanguage.English,
    theme: 'family',
    educationalMessage: null,
    pageCount: 6,
    status,
    previewPdfUrl: published ? '/private/book.pdf' : null,
    bookPreview: published ? preview : null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('publication availability', () => {
  it('recognizes a complete publication from artifact metadata', () => {
    expect(hasPublishedBook(book(BookStatus.Complete))).toBe(true);
    expect(publishedVersionStatusMessage(book(BookStatus.Complete))).toBeNull();
  });

  it.each([
    [BookStatus.CharBuild, /new version is being generated/i],
    [BookStatus.Failed, /could not be generated/i],
    [BookStatus.Cancelled, /was cancelled/i],
  ])('keeps a publication available while workflow status is %s', (status, message) => {
    const value = book(status);
    expect(hasPublishedBook(value)).toBe(true);
    expect(publishedVersionStatusMessage(value)).toMatch(message);
  });

  it('does not invent a publication for a failed initial generation', () => {
    const value = book(BookStatus.Failed, false);
    expect(hasPublishedBook(value)).toBe(false);
    expect(publishedVersionStatusMessage(value)).toBeNull();
  });

  it('requires both the PDF pointer and readable preview metadata', () => {
    expect(hasPublishedBook({ ...book(BookStatus.Complete), previewPdfUrl: null })).toBe(false);
    expect(hasPublishedBook({ ...book(BookStatus.Complete), bookPreview: null })).toBe(false);
  });

  it('recognizes the published PDF pointer independently of reader metadata', () => {
    const value = { ...book(BookStatus.Complete), bookPreview: null };
    expect(hasPublishedPdf(value)).toBe(true);
    expect(hasPublishedBook(value)).toBe(false);
  });
});
