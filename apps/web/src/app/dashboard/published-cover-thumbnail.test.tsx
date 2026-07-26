import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { booksApi } from '@/lib/api/books';
import { PublishedCoverThumbnail } from './published-cover-thumbnail';

vi.mock('@/lib/api/books', () => ({
  booksApi: {
    downloadPublishedImage: vi.fn(),
  },
}));

describe('PublishedCoverThumbnail', () => {
  beforeEach(() => {
    vi.mocked(booksApi.downloadPublishedImage).mockResolvedValue(
      new Blob(['cover'], { type: 'image/png' }),
    );
    global.URL.createObjectURL = vi.fn(() => 'blob:cover');
    global.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('loads the ownership-checked published cover', async () => {
    render(<PublishedCoverThumbnail bookId="book-1" title="Emma's Story" />);

    expect(await screen.findByAltText("Cover of Emma's Story")).toHaveAttribute(
      'src',
      'blob:cover',
    );
    expect(booksApi.downloadPublishedImage).toHaveBeenCalledWith('book-1', 'cover');
  });

  it('revokes the Blob URL when the card unmounts', async () => {
    const { unmount } = render(<PublishedCoverThumbnail bookId="book-1" title="Emma's Story" />);
    await screen.findByAltText("Cover of Emma's Story");

    unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:cover');
  });

  it('shows a quiet fallback when the published cover cannot be loaded', async () => {
    vi.mocked(booksApi.downloadPublishedImage).mockRejectedValue(new Error('missing'));

    render(<PublishedCoverThumbnail bookId="book-1" title="Emma's Story" />);

    expect(await screen.findByRole('img', { name: 'Published cover unavailable' })).toBeDefined();
  });
});
