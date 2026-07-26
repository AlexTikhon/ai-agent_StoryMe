import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BookStatus, type BookDto, type BookPreview } from '@book/types';
import { booksApi } from '@/lib/api/books';
import { PublishedBookReader } from './published-book-reader';

vi.mock('@/lib/api/books', () => ({
  booksApi: {
    downloadPublishedImage: vi.fn(),
    updatePageText: vi.fn(),
  },
}));

const PREVIEW: BookPreview = {
  title: "Emma's Adventure",
  subtitle: 'A story about friendship',
  cover: {
    title: "Emma's Adventure",
    subtitle: 'A story about friendship',
    childName: 'Emma',
    illustrationPrompt: 'A friendly cover',
  },
  pages: [
    {
      pageNumber: 2,
      title: 'Home Again',
      text: 'Emma returned home with a new friend.',
      illustrationPrompt: 'Emma and a friend',
      layout: 'image_top_text_bottom',
      learningGoal: 'Friendship',
    },
    {
      pageNumber: 1,
      title: 'The First Step',
      text: 'Emma followed the glowing path.',
      illustrationPrompt: 'Emma on a path',
      layout: 'image_top_text_bottom',
      learningGoal: 'Courage',
      version: 4,
    },
  ],
  backCover: {
    message: 'The end',
    educationalSummary: 'Kindness makes every adventure better.',
  },
  metadata: {
    language: 'en',
    theme: 'Friendship',
    childAge: 5,
    totalPages: 2,
    generatedBy: 'mock',
  },
};

describe('PublishedBookReader', () => {
  let objectUrlCounter: number;

  beforeEach(() => {
    objectUrlCounter = 0;
    vi.mocked(booksApi.downloadPublishedImage).mockResolvedValue(
      new Blob(['image'], { type: 'image/png' }),
    );
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => `blob:reader-${++objectUrlCounter}`),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads the published cover and navigates through sorted pages to the back cover', async () => {
    render(<PublishedBookReader bookId="book-1" preview={PREVIEW} />);

    expect(await screen.findByAltText('Illustration for cover')).toHaveAttribute(
      'src',
      'blob:reader-1',
    );
    expect(booksApi.downloadPublishedImage).toHaveBeenLastCalledWith('book-1', 'cover');

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByAltText('Illustration for page 1')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The First Step' })).toBeInTheDocument();
    expect(booksApi.downloadPublishedImage).toHaveBeenLastCalledWith('book-1', 'page-1');

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByAltText('Illustration for page 2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByAltText('Illustration for back cover')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The end' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(booksApi.downloadPublishedImage).toHaveBeenLastCalledWith('book-1', 'back-cover');
  });

  it('revokes each Blob URL when changing pages or unmounting', async () => {
    const { unmount } = render(<PublishedBookReader bookId="book-1" preview={PREVIEW} />);
    await screen.findByAltText('Illustration for cover');

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByAltText('Illustration for page 1');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:reader-1');

    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:reader-2');
  });

  it('shows a recoverable page error and retries the same published image', async () => {
    vi.mocked(booksApi.downloadPublishedImage)
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(new Blob(['image'], { type: 'image/png' }));

    render(<PublishedBookReader bookId="book-1" preview={PREVIEW} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry page' }));

    await waitFor(() => {
      expect(screen.getByAltText('Illustration for cover')).toBeInTheDocument();
    });
    expect(booksApi.downloadPublishedImage).toHaveBeenCalledTimes(2);
    expect(booksApi.downloadPublishedImage).toHaveBeenLastCalledWith('book-1', 'cover');
  });

  it('edits one story page with its optimistic version and returns the updated book', async () => {
    const onBookUpdated = vi.fn();
    const updatedBook = {
      id: 'book-1',
      status: BookStatus.Complete,
      bookPreview: {
        ...PREVIEW,
        pages: PREVIEW.pages.map((page) =>
          page.pageNumber === 1 ? { ...page, text: 'A safer new ending.', version: 5 } : page,
        ),
      },
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T01:00:00.000Z',
    } as BookDto;
    vi.mocked(booksApi.updatePageText).mockResolvedValueOnce(updatedBook);

    render(<PublishedBookReader bookId="book-1" preview={PREVIEW} onBookUpdated={onBookUpdated} />);
    await screen.findByAltText('Illustration for cover');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByAltText('Illustration for page 1');

    fireEvent.click(screen.getByRole('button', { name: 'Edit page text' }));
    fireEvent.change(screen.getByLabelText('Page text'), {
      target: { value: 'A safer new ending.' },
    });
    expect(screen.getByText(/saving uses no ai call or credits/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save page' }));

    await waitFor(() => {
      expect(booksApi.updatePageText).toHaveBeenCalledWith('book-1', 1, {
        text: 'A safer new ending.',
        expectedVersion: 4,
      });
      expect(onBookUpdated).toHaveBeenCalledWith(updatedBook);
    });
  });
});
