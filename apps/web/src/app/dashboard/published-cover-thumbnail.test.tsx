import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { booksApi } from '@/lib/api/books';
import { PublishedCoverThumbnail } from './published-cover-thumbnail';

vi.mock('@/lib/api/books', () => ({
  booksApi: {
    downloadPublishedImage: vi.fn(),
  },
}));

type ObserverCallback = (entries: Array<{ isIntersecting: boolean }>) => void;

/** Controllable IntersectionObserver so tests decide when a card is "near" the viewport. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(
    private readonly callback: ObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this);
  }
  trigger(isIntersecting: boolean) {
    this.callback([{ isIntersecting }]);
  }
}

/** A download that stays pending until aborted, like a real in-flight fetch. */
function pendingUntilAborted(
  _id: string,
  _image: string,
  _edition?: string,
  signal?: AbortSignal,
): Promise<Blob> {
  return new Promise<Blob>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
}

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
    render(<PublishedCoverThumbnail bookId="book-1" title="Emma's Story" edition="edition-1" />);

    expect(await screen.findByAltText("Cover of Emma's Story")).toHaveAttribute(
      'src',
      'blob:cover',
    );
    expect(booksApi.downloadPublishedImage).toHaveBeenCalledWith(
      'book-1',
      'cover-thumb',
      'edition-1',
      expect.any(AbortSignal),
    );
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

describe('PublishedCoverThumbnail deferred loading', () => {
  beforeEach(() => {
    FakeIntersectionObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.mocked(booksApi.downloadPublishedImage).mockReset();
    vi.mocked(booksApi.downloadPublishedImage).mockResolvedValue(
      new Blob(['cover'], { type: 'image/webp' }),
    );
    global.URL.createObjectURL = vi.fn(() => 'blob:cover');
    global.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('does not fetch while the card is offscreen, then fetches once it nears the viewport', async () => {
    render(<PublishedCoverThumbnail bookId="book-1" title="Emma's Story" edition="e1" />);
    await act(async () => {});

    expect(booksApi.downloadPublishedImage).not.toHaveBeenCalled();
    const observer = FakeIntersectionObserver.instances[0]!;
    expect(observer.options?.rootMargin).toBe('200px');

    act(() => observer.trigger(false));
    expect(booksApi.downloadPublishedImage).not.toHaveBeenCalled();

    act(() => observer.trigger(true));
    expect(await screen.findByAltText("Cover of Emma's Story")).toBeDefined();
    expect(booksApi.downloadPublishedImage).toHaveBeenCalledTimes(1);
    expect(observer.disconnect).toHaveBeenCalled();
  });

  it('caps concurrent cover downloads and starts queued ones as slots free up', async () => {
    vi.mocked(booksApi.downloadPublishedImage).mockImplementation(pendingUntilAborted);
    const { unmount } = render(
      <>
        {Array.from({ length: 7 }, (_, index) => (
          <PublishedCoverThumbnail key={index} bookId={`book-${index}`} title={`Book ${index}`} />
        ))}
      </>,
    );
    await act(async () => {
      for (const observer of FakeIntersectionObserver.instances) observer.trigger(true);
    });

    expect(booksApi.downloadPublishedImage).toHaveBeenCalledTimes(4);

    // Scrolling away aborts the in-flight and queued requests; nothing starts afterwards.
    unmount();
    await act(async () => {});
    expect(booksApi.downloadPublishedImage).toHaveBeenCalledTimes(4);
  });

  it('releases the previous cover and loads the new edition when the edition changes', async () => {
    vi.mocked(global.URL.createObjectURL as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce('blob:edition-1')
      .mockReturnValueOnce('blob:edition-2');
    const { rerender } = render(
      <PublishedCoverThumbnail bookId="book-1" title="Emma" edition="edition-1" />,
    );
    await act(async () => {
      FakeIntersectionObserver.instances[0]!.trigger(true);
    });
    expect(await screen.findByAltText('Cover of Emma')).toHaveAttribute('src', 'blob:edition-1');

    rerender(<PublishedCoverThumbnail bookId="book-1" title="Emma" edition="edition-2" />);

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:edition-1');
    expect(await screen.findByAltText('Cover of Emma')).toHaveAttribute('src', 'blob:edition-2');
    expect(booksApi.downloadPublishedImage).toHaveBeenLastCalledWith(
      'book-1',
      'cover-thumb',
      'edition-2',
      expect.any(AbortSignal),
    );
  });

  it('aborts an in-flight request when the edition changes', async () => {
    const signals: AbortSignal[] = [];
    vi.mocked(booksApi.downloadPublishedImage).mockImplementation((id, image, edition, signal) => {
      if (signal) signals.push(signal);
      return pendingUntilAborted(id, image, edition, signal);
    });
    const { rerender, unmount } = render(
      <PublishedCoverThumbnail bookId="book-1" title="Emma" edition="edition-1" />,
    );
    await act(async () => {
      FakeIntersectionObserver.instances[0]!.trigger(true);
    });
    expect(signals).toHaveLength(1);

    rerender(<PublishedCoverThumbnail bookId="book-1" title="Emma" edition="edition-2" />);

    expect(signals[0]!.aborted).toBe(true);
    unmount();
  });
});
