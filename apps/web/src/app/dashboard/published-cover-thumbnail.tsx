'use client';

import { useEffect, useRef, useState } from 'react';
import { booksApi } from '@/lib/api/books';
import { createAsyncLimiter } from '@/lib/async-limiter';

/** Start fetching a little before the card scrolls into view. */
const VIEWPORT_MARGIN = '200px';
/** Covers on screen at once — keeps a fast scroll from flooding the API/object store. */
const MAX_CONCURRENT_COVER_LOADS = 4;

const coverLoadLimiter = createAsyncLimiter(MAX_CONCURRENT_COVER_LOADS);

interface PublishedCoverThumbnailProps {
  edition?: string | null | undefined;
  bookId: string;
  title: string;
}

export function PublishedCoverThumbnail({ bookId, title, edition }: PublishedCoverThumbnailProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Latches true the first time the card approaches the viewport. Without
  // IntersectionObserver there is nothing to defer on, so load straight away.
  useEffect(() => {
    const node = containerRef.current;
    if (typeof IntersectionObserver === 'undefined' || !node) {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: VIEWPORT_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Fetches the small cover derivative (not the full illustration). A new
  // edition re-runs this: the cleanup aborts any in-flight request and revokes
  // the previous Blob URL before the next one is created.
  useEffect(() => {
    setImageUrl(null);
    setFailed(false);
    if (!nearViewport) return;

    let cancelled = false;
    let objectUrl: string | null = null;
    const controller = new AbortController();

    void coverLoadLimiter
      .run(
        () =>
          booksApi.downloadPublishedImage(
            bookId,
            'cover-thumb',
            edition ?? undefined,
            controller.signal,
          ),
        controller.signal,
      )
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bookId, edition, nearViewport]);

  return (
    <div
      ref={containerRef}
      className="mb-4 flex aspect-[3/4] items-center justify-center overflow-hidden rounded-xl bg-violet-50"
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={`Cover of ${title}`}
          decoding="async"
          className="h-full w-full object-contain"
        />
      ) : (
        <span
          role="img"
          aria-label={failed ? 'Published cover unavailable' : 'Loading published cover'}
          className="text-3xl"
        >
          📖
        </span>
      )}
    </div>
  );
}
