'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  BookDto,
  BookPreview,
  PageImageRegenerationQuote,
  PageImageRevisionDto,
  PublishedBookImageId,
} from '@book/types';
import { booksApi } from '@/lib/api/books';

interface ReaderSlide {
  imageId: PublishedBookImageId;
  label: string;
  title: string;
  text?: string;
  pageNumber?: number;
  version?: number;
}

interface PublishedBookReaderProps {
  bookId: string;
  preview: BookPreview;
  onBookUpdated?: (book: BookDto) => void;
  allowRevisions?: boolean;
}

export function PublishedBookReader({
  bookId,
  preview,
  onBookUpdated,
  allowRevisions = true,
}: PublishedBookReaderProps) {
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
          pageNumber: page.pageNumber,
          version: page.version ?? 1,
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
  const [editingText, setEditingText] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [savingText, setSavingText] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [imageQuote, setImageQuote] = useState<PageImageRegenerationQuote | null>(null);
  const [imageRevision, setImageRevision] = useState<PageImageRevisionDto | null>(null);
  const [requestingImageQuote, setRequestingImageQuote] = useState(false);
  const [confirmingImage, setConfirmingImage] = useState(false);
  const [imageActionError, setImageActionError] = useState<string | null>(null);
  const slide = slides[currentIndex];
  const imageRevisionActive =
    imageRevision?.status === 'queued' || imageRevision?.status === 'running';
  const imageActionBusy = requestingImageQuote || confirmingImage || imageRevisionActive;

  useEffect(() => {
    setCurrentIndex(0);
  }, [bookId]);

  useEffect(() => {
    setEditingText(false);
    setDraftText(slide.text ?? '');
    setSaveError(null);
    setImageQuote(null);
    setImageRevision(null);
    setImageActionError(null);
  }, [slide.imageId, slide.text]);

  const savePageText = async () => {
    if (!slide.pageNumber || !onBookUpdated) return;
    const text = draftText.trim();
    if (!text) {
      setSaveError('Page text cannot be empty.');
      return;
    }
    setSavingText(true);
    setSaveError(null);
    try {
      const updated = await booksApi.updatePageText(bookId, slide.pageNumber, {
        text,
        expectedVersion: slide.version ?? 1,
      });
      onBookUpdated(updated);
      setEditingText(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to update page text.');
    } finally {
      setSavingText(false);
    }
  };

  const requestImageQuote = async () => {
    if (!slide.pageNumber || !onBookUpdated) return;
    setRequestingImageQuote(true);
    setImageActionError(null);
    try {
      const quote = await booksApi.createPageImageQuote(bookId, slide.pageNumber, {
        expectedVersion: slide.version ?? 1,
      });
      setImageQuote(quote);
    } catch (error) {
      setImageActionError(
        error instanceof Error ? error.message : 'Failed to load the regeneration price.',
      );
    } finally {
      setRequestingImageQuote(false);
    }
  };

  const confirmImageRevision = async () => {
    if (!slide.pageNumber || !imageQuote) return;
    setConfirmingImage(true);
    setImageActionError(null);
    try {
      const revision = await booksApi.confirmPageImageRevision(
        bookId,
        slide.pageNumber,
        imageQuote.id,
      );
      setImageRevision(revision);
    } catch (error) {
      setImageActionError(
        error instanceof Error ? error.message : 'Failed to start image regeneration.',
      );
    } finally {
      setConfirmingImage(false);
    }
  };

  useEffect(() => {
    if (!imageRevisionActive || !imageRevision) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const current = await booksApi.getPageImageRevision(bookId, imageRevision.id);
        if (cancelled) return;
        setImageRevision(current);
        if (current.status === 'completed' && current.book) {
          onBookUpdated?.(current.book);
          setImageQuote(null);
          setRetryNonce((value) => value + 1);
          return;
        }
        if (current.status === 'failed') {
          setImageActionError(
            current.errorMessage ??
              'The illustration could not be regenerated. Your credit was refunded.',
          );
          return;
        }
        timer = setTimeout(() => void poll(), 1500);
      } catch (error) {
        if (!cancelled) {
          setImageActionError(
            error instanceof Error ? error.message : 'Failed to check regeneration status.',
          );
        }
      }
    };

    timer = setTimeout(() => void poll(), 500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [bookId, imageRevision, imageRevisionActive, onBookUpdated]);

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
          {!editingText && slide.text && (
            <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-text-secondary">
              {slide.text}
            </p>
          )}
          {editingText && (
            <div className="mt-3 text-left">
              <label
                htmlFor={`page-text-${slide.pageNumber}`}
                className="mb-1 block text-sm font-semibold text-text-primary"
              >
                Page text
              </label>
              <textarea
                id={`page-text-${slide.pageNumber}`}
                value={draftText}
                onChange={(event) => setDraftText(event.target.value)}
                maxLength={2000}
                rows={7}
                disabled={savingText}
                className="w-full rounded-lg border border-border-default px-3 py-2 text-sm text-text-primary"
              />
              <p className="mt-1 text-xs text-text-muted">
                Saving uses no AI call or credits. StoryMe rebuilds the PDF and keeps every
                published illustration unchanged.
              </p>
              {saveError && (
                <p role="alert" className="mt-2 text-sm text-danger-base">
                  {saveError}
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => void savePageText()}
                  disabled={savingText}
                  className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {savingText ? 'Saving page…' : 'Save page'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingText(false);
                    setDraftText(slide.text ?? '');
                    setSaveError(null);
                  }}
                  disabled={savingText}
                  className="rounded-lg border border-border-default px-3 py-1.5 text-sm font-semibold text-text-secondary disabled:opacity-60"
                >
                  Cancel edit
                </button>
              </div>
            </div>
          )}
          {!editingText && slide.pageNumber && onBookUpdated && allowRevisions && (
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setDraftText(slide.text ?? '');
                  setSaveError(null);
                  setEditingText(true);
                }}
                disabled={imageActionBusy}
                className="rounded-lg border border-violet-300 px-3 py-1.5 text-sm font-semibold text-violet-700 disabled:opacity-60"
              >
                Edit page text
              </button>
              <button
                type="button"
                onClick={() => void requestImageQuote()}
                disabled={imageActionBusy || imageQuote !== null}
                className="rounded-lg border border-violet-300 px-3 py-1.5 text-sm font-semibold text-violet-700 disabled:opacity-60"
              >
                {requestingImageQuote ? 'Loading price…' : 'Regenerate illustration'}
              </button>
            </div>
          )}
          {imageQuote && !imageRevisionActive && imageRevision?.status !== 'completed' && (
            <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-left">
              <p className="text-sm font-semibold text-amber-900">
                {imageQuote.costCredits > 0
                  ? 'Confirm paid regeneration'
                  : 'Confirm illustration regeneration'}
              </p>
              <p className="mt-1 text-xs text-amber-800">
                This regenerates only page {imageQuote.pageNumber}.
                {imageQuote.costCredits > 0
                  ? ` It costs ${imageQuote.costCredits} credit${
                      imageQuote.costCredits === 1 ? '' : 's'
                    }.`
                  : ' No credit purchase is needed in family mode.'}
                {imageQuote.estimatedCostUsd != null
                  ? ` Estimated provider cost: $${imageQuote.estimatedCostUsd.toFixed(2)}.`
                  : ''}{' '}
                The previous published book stays available if the operation fails.
                {imageQuote.costCredits > 0 ? ' A failed operation is refunded.' : ''}
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => void confirmImageRevision()}
                  disabled={confirmingImage}
                  className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {confirmingImage
                    ? 'Confirming…'
                    : imageQuote.costCredits > 0
                      ? `Confirm ${imageQuote.costCredits}-credit call`
                      : 'Confirm regeneration'}
                </button>
                <button
                  type="button"
                  onClick={() => setImageQuote(null)}
                  disabled={confirmingImage}
                  className="rounded-lg border border-border-default px-3 py-1.5 text-sm font-semibold text-text-secondary disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {imageRevisionActive && (
            <p role="status" className="mt-3 text-sm text-violet-700">
              Regenerating this illustration. The current published page remains available…
            </p>
          )}
          {imageRevision?.status === 'completed' && (
            <p role="status" className="mt-3 text-sm text-success-base">
              The new illustration and PDF are published.
            </p>
          )}
          {imageActionError && (
            <p role="alert" className="mt-3 text-sm text-danger-base">
              {imageActionError}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-violet-100 px-4 py-3">
        <button
          type="button"
          onClick={() => setCurrentIndex((value) => Math.max(0, value - 1))}
          disabled={currentIndex === 0 || savingText || imageActionBusy}
          className="rounded-lg border border-border-default bg-white px-3 py-1.5 text-sm font-semibold text-text-secondary disabled:opacity-40"
        >
          Previous page
        </button>
        <button
          type="button"
          onClick={() => setCurrentIndex((value) => Math.min(slides.length - 1, value + 1))}
          disabled={currentIndex === slides.length - 1 || savingText || imageActionBusy}
          className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
        >
          Next page
        </button>
      </div>
    </section>
  );
}
