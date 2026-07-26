'use client';

import { useEffect, useState } from 'react';
import { booksApi } from '@/lib/api/books';

interface PublishedCoverThumbnailProps {
  bookId: string;
  title: string;
}

export function PublishedCoverThumbnail({ bookId, title }: PublishedCoverThumbnailProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    setImageUrl(null);
    setFailed(false);
    void booksApi
      .downloadPublishedImage(bookId, 'cover')
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
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bookId]);

  return (
    <div className="mb-4 flex aspect-[3/4] items-center justify-center overflow-hidden rounded-xl bg-violet-50">
      {imageUrl ? (
        <img src={imageUrl} alt={`Cover of ${title}`} className="h-full w-full object-contain" />
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
