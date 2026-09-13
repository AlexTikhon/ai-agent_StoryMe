'use client';

import { useEffect, useState } from 'react';
import { booksApi } from '@/lib/api/books';

interface PublishedCoverThumbnailProps {
  edition?: string | null | undefined;
  bookId: string;
  title: string;
}

export function PublishedCoverThumbnail({ bookId, title, edition }: PublishedCoverThumbnailProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    const controller = new AbortController();

    setImageUrl(null);
    setFailed(false);
    void booksApi
      .downloadPublishedImage(bookId, 'cover', edition ?? undefined, controller.signal)
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
  }, [bookId, edition]);

  return (
    <div className="mb-4 flex aspect-[3/4] items-center justify-center overflow-hidden rounded-xl bg-violet-50">
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={`Cover of ${title}`}
          loading="lazy"
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
