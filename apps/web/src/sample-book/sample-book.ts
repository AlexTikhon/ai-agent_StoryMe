import fixture from './sample-book.json';

/**
 * The public sample book. `sample-book.json` is the single canonical source for
 * its story text, illustration alternatives and asset paths: the /sample-book
 * page renders it directly, and the offline generator
 * (`pnpm --filter @book/api render:sample-book`) reads the same file from disk
 * to build the bundled PDF. The content is curated and fictional — never a
 * user's book and never presented as generated output.
 */
export interface SampleIllustration {
  src: string;
  width: number;
  height: number;
  alt: string;
}

export interface SampleStoryPage {
  pageNumber: number;
  heading: string;
  text: string;
  illustration: SampleIllustration;
}

export interface SampleBook {
  id: string;
  title: string;
  childName: string;
  readingAge: string;
  provenance: string;
  cover: { illustration: SampleIllustration };
  pages: SampleStoryPage[];
  backCover: { text: string; illustration: SampleIllustration };
  pdf: { href: string; pageCount: number };
}

export const SAMPLE_BOOK: SampleBook = fixture;

export const SAMPLE_BOOK_PATH = '/sample-book';

/** In-page anchor ids, in reading order: cover, story pages, back cover. */
export const SAMPLE_SECTION_IDS = {
  cover: 'cover',
  page: (pageNumber: number) => `page-${pageNumber}`,
  backCover: 'back-cover',
} as const;
