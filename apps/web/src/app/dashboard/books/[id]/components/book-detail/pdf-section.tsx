import { useState, type MouseEvent } from 'react';
import { BookStatus, type BookDto } from '@book/types';
import { booksApi, bookPdfPreviewUrl } from '@/lib/api/books';
import { safePdfFilename } from '@/lib/pdf-filename';
import { hasPublishedPdf } from '../../publication-availability';

export function PdfSection({ book }: { book: BookDto }) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const isCancelled = book.status === BookStatus.Cancelled;
  const pdfApiUrl = hasPublishedPdf(book) ? bookPdfPreviewUrl(book.id) : null;
  const previewPages = book.bookPreview?.pages;
  const hasGeneratedPages = Array.isArray(previewPages) && previewPages.length > 0;
  const canDownloadPdf = Boolean(pdfApiUrl) && hasGeneratedPages;

  // A plain `<a target="_blank">` navigation can't attach the Authorization
  // header the API requires, so the click is intercepted here: fetch the PDF
  // through the authenticated client and open the resulting blob instead. The
  // href itself is left pointing at the real API endpoint (kept stable for
  // right-click/copy-link and so the link degrades sensibly if JS fails).
  const handleOpen = async (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (opening) return;

    // Open the tab while this handler still has the browser's user-gesture
    // permission. Opening it only after the authenticated fetch resolves is
    // treated as an unsolicited popup by Safari and stricter browser setups.
    const pdfWindow = window.open('about:blank', '_blank');
    if (!pdfWindow) {
      setOpenError('Your browser blocked the PDF tab. Allow popups and try again.');
      return;
    }
    pdfWindow.opener = null;

    setOpening(true);
    setOpenError(null);
    try {
      const blob = await booksApi.downloadPdf(book.id);
      const objectUrl = URL.createObjectURL(blob);
      pdfWindow.location.replace(objectUrl);
      // Keep the URL alive long enough for the browser's PDF viewer to take
      // ownership, then release the backing Blob instead of leaking it for
      // the lifetime of the dashboard tab.
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch {
      pdfWindow.close();
      setOpenError('Could not open PDF. Please try again.');
    } finally {
      setOpening(false);
    }
  };

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const blob = await booksApi.downloadPdf(book.id);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = safePdfFilename(book.title);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      setDownloadError('PDF download failed. Please try again.');
    } finally {
      setDownloading(false);
    }
  };

  const pdfActions = pdfApiUrl && (
    <PdfReadyActions
      pdfApiUrl={pdfApiUrl}
      opening={opening}
      openError={openError}
      downloading={downloading}
      downloadError={downloadError}
      canDownloadPdf={canDownloadPdf}
      onOpen={(e) => void handleOpen(e)}
      onDownload={() => void handleDownload()}
    />
  );

  if (pdfApiUrl) {
    const currentPublication = book.status === BookStatus.Complete;
    return (
      <div
        className={`mb-6 rounded-xl border p-4 ${
          currentPublication ? 'border-emerald-200 bg-emerald-50' : 'border-sky-200 bg-sky-50'
        }`}
      >
        <h2
          className={`mb-1 font-display text-base font-semibold ${
            currentPublication ? 'text-emerald-800' : 'text-sky-800'
          }`}
        >
          {currentPublication
            ? 'Your PDF is ready'
            : isCancelled
              ? 'Previous PDF still available'
              : 'Published PDF remains available'}
        </h2>
        <p className={`mb-4 text-xs ${currentPublication ? 'text-emerald-600' : 'text-sky-700'}`}>
          {currentPublication
            ? 'Preview PDF · locally generated file'
            : 'This is the most recent successfully published version.'}
        </p>
        {pdfActions}
      </div>
    );
  }

  if (book.status === BookStatus.PdfRender) {
    return (
      <div className="mb-6 rounded-xl border border-violet-100 bg-violet-50 p-4">
        <h2 className="mb-1 font-display text-base font-semibold text-violet-800">
          Rendering PDF…
        </h2>
        <p className="text-sm text-violet-700">
          Your storybook PDF is being assembled. This usually takes a few seconds.
        </p>
      </div>
    );
  }

  if (book.status === BookStatus.Complete) {
    return (
      <div className="mb-6 rounded-xl border border-stone-200 bg-stone-50 p-4">
        <p className="text-sm text-text-muted">
          Book is complete, but PDF link is not available yet.
        </p>
      </div>
    );
  }

  if (isCancelled) {
    return (
      <div className="mb-6 rounded-xl border border-stone-200 bg-stone-50 p-4">
        <p className="text-sm text-text-muted">
          Generation was cancelled before a PDF was produced.
        </p>
      </div>
    );
  }

  if (book.status === BookStatus.Failed) {
    return (
      <div className="mb-6 rounded-xl border border-danger-base/20 bg-danger-light p-4">
        <p className="text-sm text-danger-base">Generation failed. Please contact support.</p>
      </div>
    );
  }

  return null;
}

function PdfReadyActions({
  pdfApiUrl,
  opening,
  openError,
  downloading,
  downloadError,
  canDownloadPdf,
  onOpen,
  onDownload,
}: {
  pdfApiUrl: string;
  opening: boolean;
  openError: string | null;
  downloading: boolean;
  downloadError: string | null;
  canDownloadPdf: boolean;
  onOpen: (e: MouseEvent<HTMLAnchorElement>) => void;
  onDownload: () => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <a
          href={pdfApiUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onOpen}
          className="inline-flex h-9 items-center rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500"
        >
          {opening ? 'Opening…' : 'Open PDF'}
        </a>
        {canDownloadPdf ? (
          <button
            type="button"
            onClick={onDownload}
            disabled={downloading}
            className="inline-flex h-9 items-center rounded-xl border border-border-default px-4 text-sm font-semibold text-text-secondary transition-all hover:bg-stone-100 disabled:opacity-60"
          >
            {downloading ? 'Preparing PDF…' : 'Download PDF'}
          </button>
        ) : (
          <p className="text-xs text-text-muted">No pages available to export yet.</p>
        )}
      </div>
      {(openError ?? downloadError) && (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-danger-light px-3 py-2 text-xs text-danger-base"
        >
          {openError ?? downloadError}
        </p>
      )}
    </>
  );
}

// ── Skeleton / Not Found ──────────────────────────────────────────────────────
