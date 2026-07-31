import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BookStatus, SupportedLanguage, type BookDto, type BookPreview } from '@book/types';
import { BookDetailView } from './book-detail-view';

vi.mock('next/link', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, className }: any) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const preview: BookPreview = {
  title: 'Mia and the Moon',
  subtitle: 'A family story',
  cover: {
    title: 'Mia and the Moon',
    subtitle: 'A family story',
    childName: 'Mia',
    illustrationPrompt: 'Cover art',
  },
  pages: [
    {
      pageNumber: 1,
      title: 'Moonlight',
      text: 'Mia followed the moonlight.',
      illustrationPrompt: 'Page art',
      layout: 'image_top_text_bottom',
      learningGoal: 'Curiosity',
    },
  ],
  backCover: { message: 'The end', educationalSummary: 'Stay curious' },
  metadata: {
    language: 'en',
    theme: 'family',
    childAge: 5,
    totalPages: 1,
    generatedBy: 'LocalPipelineAgent',
  },
};

function makeBook(status: BookStatus, published = true): BookDto {
  return {
    id: 'book-1',
    userId: 'user-1',
    title: 'Mia and the Moon',
    childName: 'Mia',
    childAge: 5,
    language: SupportedLanguage.English,
    theme: 'family',
    educationalMessage: null,
    pageCount: 6,
    status,
    previewPdfUrl: published ? '/private/storybook.pdf' : null,
    bookPreview: published ? preview : null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function renderView(book: BookDto) {
  const noop = vi.fn();
  return render(
    <BookDetailView
      book={book}
      onEdit={noop}
      onDelete={noop}
      deleting={false}
      onGenerate={noop}
      generating={false}
      generateError={null}
      generateInsufficientCredits={false}
      onRefresh={noop}
      refreshing={false}
      progress={null}
      diagnostics={null}
      diagnosticsError={null}
      showDeveloperDiagnostics={false}
      onRegenerate={noop}
      retrying={false}
      retryError={null}
      retryInsufficientCredits={false}
      justEdited={false}
      onCancel={noop}
      cancelling={false}
      cancelError={null}
      cancelMessage={null}
      onBookUpdated={noop}
    />,
  );
}

describe('BookDetailView publication availability', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_PRODUCT_MODE', 'home');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        blob: async () => new Blob(['image'], { type: 'image/png' }),
      }),
    );
    global.URL.createObjectURL = vi.fn(() => 'blob:published-image');
    global.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('renders a complete publication', () => {
    renderView(makeBook(BookStatus.Complete));
    expect(screen.getByRole('region', { name: /published book reader/i })).toBeDefined();
    expect(screen.getByRole('heading', { name: /your pdf is ready/i })).toBeDefined();
  });

  it.each([
    [BookStatus.CharBuild, /new version is being generated/i],
    [BookStatus.Failed, /new version could not be generated/i],
    [BookStatus.Cancelled, /new version was cancelled/i],
  ])('keeps the published reader visible for %s regeneration', (status, message) => {
    renderView(makeBook(status));
    expect(screen.getByRole('region', { name: /published book reader/i })).toBeDefined();
    expect(screen.getByText(message)).toBeDefined();
    expect(
      screen.getByRole('heading', {
        name: /(?:published pdf remains available|previous pdf still available)/i,
      }),
    ).toBeDefined();
  });

  it('shows failure without a reader after failed initial generation', () => {
    renderView(makeBook(BookStatus.Failed, false));
    expect(screen.queryByRole('region', { name: /published book reader/i })).toBeNull();
    expect(screen.getByText(/generation failed/i)).toBeDefined();
  });
});
