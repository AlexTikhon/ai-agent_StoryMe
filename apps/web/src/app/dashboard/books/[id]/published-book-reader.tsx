'use client';

import { useEffect, useMemo, useState } from 'react';
import type { BookPreview, PublishedBookImageId } from '@book/types';
import { booksApi } from '@/lib/api/books';

interface ReaderSlide {
  imageId: PublishedBookImageId;
  label: string;
  title: string;
  text?: string;
}

interface PublishedBookReaderProps {
  bookId: string;
  preview: BookPreview;
}

export function PublishedBookReader({ bookId, preview }: PublishedBookReaderProps) {
  const slides = useMemo<ReaderSlide[]>(
    () => [
      {
        imageId: 'cover',
        label: 'Cover',
        title: preview.cover.title,
        text: preview.cover.subtitle,
      },
      ...preview.pages
        .slice()
        .sort((left, right) => left.pageNumber - right.pageNumber)
        .map((page) => ({
          imageId: `page-${page.pageNumber}` as PublishedBookImageId,
          label: `Page ${page.pageNumber}`,
          title: page.title,
          text: page.text,
        })),
      {
        imageId: 'back-cover',
        label: 'Back cover',
        title: preview.backCover.message,
        text: preview.backCover.educationalSummary,
      },
    ],
    [preview],
  );
  const [currentIndex, setCurrentIndex] = useState(0);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const slide = slides[currentIndex];

  useEffect(() => {
    setCurrentIndex(0);
  }, [bookId]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    setImageUrl(null);
    setLoading(true);
    setLoadError(null);

    void booksApi
      .downloadPublishedImage(bookId, slide.imageId)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError('This published page could not be loaded. Please try again.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bookId, retryNonce, slide.imageId]);

  return (
    <section
      aria-label="Published book reader"
      className="mb-6 overflow-hidden rounded-xl border border-violet-200 bg-violet-50"
    >
      <div className="border-b border-violet-100 px-4 py-3">
        <h2 className="font-display text-base font-semibold text-violet-900">Read your book</h2>
        <p className="text-xs text-violet-700">
          {slide.label} · {currentIndex + 1} of {slides.length}
        </p>
      </div>

      <div className="bg-white p-4">
        <div className="flex min-h-64 items-center justify-center overflow-hidden rounded-lg bg-stone-100">
          {loading && (
            <p role="status" className="text-sm text-text-muted">
              Loading {slide.label.toLowerCase()}…
            </p>
          )}
          {!loading && loadError && (
            <div className="px-6 text-center">
              <p role="alert" className="mb-3 text-sm text-danger-base">
                {loadError}
              </p>
              <button
                type="button"
                onClick={() => setRetryNonce((value) => value + 1)}
                className="rounded-lg border border-border-default px-3 py-1.5 text-sm font-semibold text-text-secondary hover:bg-stone-50"
              >
                Retry page
              </button>
            </div>
          )}
          {imageUrl && (
            // Blob URLs come from the ownership-checked API and cannot be handled by Next's optimizer.
            <img
              src={imageUrl}
              alt={`Illustration for ${slide.label.toLowerCase()}`}
              className="max-h-[32rem] w-full object-contain"
            />
          )}
        </div>

        <div className="px-1 pb-1 pt-4 text-center">
          <h3 className="font-display text-lg font-semibold text-text-primary">{slide.title}</h3>
          {slide.text && (
            <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-text-secondary">
              {slide.text}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-violet-100 px-4 py-3">
        <button
          type="button"
          onClick={() => setCurrentIndex((value) => Math.max(0, value - 1))}
          disabled={currentIndex === 0}
          className="rounded-lg border border-border-default bg-white px-3 py-1.5 text-sm font-semibold text-text-secondary disabled:opacity-40"
        >
          Previous page
        </button>
        <button
          type="button"
          onClick={() => setCurrentIndex((value) => Math.min(slides.length - 1, value + 1))}
          disabled={currentIndex === slides.length - 1}
          className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
        >
          Next page
        </button>
      </div>
    </section>
  );
}
