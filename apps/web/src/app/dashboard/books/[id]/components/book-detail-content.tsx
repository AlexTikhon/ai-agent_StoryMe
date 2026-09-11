import Link from 'next/link';
import { AgentStep, BookStatus } from '@book/types';
import type {
  BookDto,
  GenerationDiagnosticsDto,
  GenerationProgressDto,
  PagePlan,
} from '@book/types';
import { isHomeProductMode } from '@/lib/product-mode';
import { GenerationDiagnosticsPanel } from '../generation-diagnostics-panel';
import { isGeneratingBookStatus } from '../use-book-detail';
import { PublishedBookReader } from '../published-book-reader';
import { hasPublishedBook, publishedVersionStatusMessage } from '../publication-availability';
import { GenerationEstimatePanel } from './generation-estimate-panel';
import { BookPreviewSection } from './book-detail/story-preview-section';
import { ImageGenerationSection } from './book-detail/image-generation-section';
import { BookLayoutSection } from './book-detail/book-layout-section';
import { StoryDiagnostics } from './book-detail/story-diagnostics';
import { PdfSection } from './book-detail/pdf-section';

function generationStatusMessage(progress: GenerationProgressDto | null): string {
  if (progress?.status === 'queued') return 'Preparing your story…';
  if (progress?.status !== 'running') return 'Preparing your story…';

  switch (progress.step) {
    case AgentStep.CharBuild:
      return 'Creating your character…';
    case AgentStep.StoryPlan:
      return 'Writing your story…';
    case AgentStep.QaReview:
      return 'Polishing your story…';
    case AgentStep.ImageGen:
      return 'Creating illustrations…';
    case AgentStep.Layout:
      return 'Building your book…';
    case AgentStep.PdfRender:
      return 'Finishing your book…';
    default:
      return 'Preparing your story…';
  }
}

export function getMissingDraftFields(book: BookDto): string[] {
  const missing: string[] = [];
  if (!book.childName) missing.push('child name');
  if (book.childAge == null) missing.push('age');
  if (!book.language) missing.push('language');
  if (!book.theme) missing.push('theme');
  return missing;
}

// ── BookDetailView ────────────────────────────────────────────────────────────

export interface BookDetailContentProps {
  book: BookDto;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
  onGenerate: () => void;
  generating: boolean;
  generateError: string | null;
  generateInsufficientCredits: boolean;
  onRefresh: () => void;
  refreshing: boolean;
  progress: GenerationProgressDto | null;
  diagnostics: GenerationDiagnosticsDto | null;
  diagnosticsError: string | null;
  showDeveloperDiagnostics: boolean;
  onRegenerate: () => void;
  retrying: boolean;
  retryError: string | null;
  retryInsufficientCredits: boolean;
  justEdited: boolean;
  onCancel: () => void;
  cancelling: boolean;
  cancelError: string | null;
  cancelMessage: string | null;
  onBookUpdated: (book: BookDto) => void;
}

export function BookDetailContent({
  book,
  onEdit,
  onDelete,
  deleting,
  onGenerate,
  generating,
  generateError,
  generateInsufficientCredits,
  onRefresh,
  refreshing,
  progress,
  diagnostics,
  diagnosticsError,
  showDeveloperDiagnostics,
  onRegenerate,
  retrying,
  retryError,
  retryInsufficientCredits,
  justEdited,
  onCancel,
  cancelling,
  cancelError,
  cancelMessage,
  onBookUpdated,
}: BookDetailContentProps) {
  const homeMode = isHomeProductMode();
  const isDraft = book.status === BookStatus.Created;
  const missingFields = getMissingDraftFields(book);
  const canGenerate = isDraft && missingFields.length === 0;
  const canEditOrDelete = !isGeneratingBookStatus(book.status);
  const isCancelled = book.status === BookStatus.Cancelled;
  // A cancelled book is eligible for a fresh regeneration, matching the
  // backend rule (BooksService.regenerateBook) — retry generation remains
  // limited to failed books, since a cancellation was voluntary, not a
  // failure to resume.
  const canRegenerate =
    book.status === BookStatus.Failed || book.status === BookStatus.Complete || isCancelled;
  const storyPlan = book.storyPlan ?? null;
  const pages: PagePlan[] | undefined =
    storyPlan?.pages && storyPlan.pages.length > 0 ? storyPlan.pages : undefined;
  const draftPages = pages?.filter((p) => p.storyText);
  const illustrationPages = pages?.filter((p) => p.illustration);
  const bookPreview = book.bookPreview ?? null;
  const imageGenerationResult = book.imageGenerationResult ?? null;
  const bookLayout = book.bookLayout ?? null;
  const publicationAvailable = hasPublishedBook(book);
  const publicationMessage = publishedVersionStatusMessage(book);

  return (
    <div>
      <div className="mb-5 flex items-center justify-between gap-2">
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            isDraft
              ? 'bg-stone-100 text-text-muted'
              : isCancelled
                ? 'bg-amber-100 text-amber-800'
                : 'bg-violet-50 text-violet-700'
          }`}
        >
          {book.status}
        </span>
        {!isDraft && (
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex h-7 items-center rounded-lg border border-border-default px-2.5 text-xs font-medium text-text-secondary transition-all hover:bg-stone-100 disabled:opacity-60"
          >
            {refreshing ? 'Refreshing…' : 'Refresh status'}
          </button>
        )}
      </div>

      <dl className="mb-6 divide-y divide-border-subtle text-sm">
        {book.childName != null && (
          <div className="flex justify-between py-2.5">
            <dt className="font-medium text-text-muted">For</dt>
            <dd className="text-text-primary">
              {book.childName}, age {book.childAge}
            </dd>
          </div>
        )}
        {book.language != null && (
          <div className="flex justify-between py-2.5">
            <dt className="font-medium text-text-muted">Language</dt>
            <dd className="text-text-primary">{book.language}</dd>
          </div>
        )}
        {book.theme != null && (
          <div className="flex justify-between py-2.5">
            <dt className="font-medium text-text-muted">Theme</dt>
            <dd className="text-text-primary">{book.theme}</dd>
          </div>
        )}
        {book.pageCount != null && (
          <div className="flex justify-between py-2.5">
            <dt className="font-medium text-text-muted">Page count</dt>
            <dd className="text-text-primary">{book.pageCount}</dd>
          </div>
        )}
        {book.educationalMessage != null && book.educationalMessage.trim().length > 0 && (
          <div className="flex justify-between gap-4 py-2.5">
            <dt className="font-medium text-text-muted">Educational message</dt>
            <dd className="text-right text-text-primary">{book.educationalMessage}</dd>
          </div>
        )}
        <div className="flex justify-between py-2.5">
          <dt className="font-medium text-text-muted">Created</dt>
          <dd className="text-text-primary">{new Date(book.createdAt).toLocaleDateString()}</dd>
        </div>
        <div className="flex justify-between py-2.5">
          <dt className="font-medium text-text-muted">Updated</dt>
          <dd className="text-text-primary">{new Date(book.updatedAt).toLocaleDateString()}</dd>
        </div>
      </dl>

      {!isDraft && showDeveloperDiagnostics && (
        <GenerationDiagnosticsPanel diagnostics={diagnostics} diagnosticsError={diagnosticsError} />
      )}

      {justEdited && canRegenerate && (
        <div className="mb-6 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Changes saved. Regenerate the book to update the story, images, and PDF with these
          changes.
        </div>
      )}

      {canRegenerate && (
        <div className="mb-6">
          <GenerationEstimatePanel
            bookId={book.id}
            kind={book.status === BookStatus.Failed ? 'retry' : 'regenerate'}
          />
          <button
            onClick={onRegenerate}
            disabled={retrying || cancelling}
            className="w-full rounded-xl bg-violet-600 py-2 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500 disabled:opacity-60"
          >
            {book.status === BookStatus.Complete || isCancelled
              ? retrying
                ? 'Regenerating…'
                : 'Regenerate book'
              : retrying
                ? 'Retrying…'
                : 'Retry generation'}
          </button>
          {retryError && (
            <p
              role="alert"
              className="mt-2 rounded-lg bg-danger-light px-4 py-3 text-sm text-danger-base"
            >
              {retryError}
              {retryInsufficientCredits && !homeMode && (
                <>
                  {' '}
                  <Link
                    href="/dashboard/credits"
                    className="font-semibold underline hover:no-underline"
                  >
                    Buy more credits
                  </Link>
                </>
              )}
            </p>
          )}
        </div>
      )}

      <StoryDiagnostics
        show={showDeveloperDiagnostics}
        storyPlan={storyPlan}
        pages={pages}
        draftPages={draftPages}
        illustrationPages={illustrationPages}
      />

      {bookPreview && <BookPreviewSection preview={bookPreview} />}

      {showDeveloperDiagnostics && imageGenerationResult && (
        <ImageGenerationSection result={imageGenerationResult} />
      )}

      {showDeveloperDiagnostics && bookLayout && <BookLayoutSection layout={bookLayout} />}

      {publicationMessage && (
        <p role="status" className="mb-4 rounded-lg bg-sky-50 px-4 py-3 text-sm text-sky-800">
          {publicationMessage}
        </p>
      )}

      {publicationAvailable && bookPreview && (
        <PublishedBookReader
          bookId={book.id}
          preview={bookPreview}
          edition={book.publishedEdition}
          onBookUpdated={onBookUpdated}
          allowRevisions={book.status === BookStatus.Complete}
        />
      )}

      <PdfSection book={book} />

      {!isDraft && isGeneratingBookStatus(book.status) && (
        <p className="mb-4 rounded-lg bg-violet-50 px-4 py-3 text-sm text-violet-700">
          {generationStatusMessage(progress)} This draft can no longer be edited.
        </p>
      )}

      {isGeneratingBookStatus(book.status) && (
        <div className="mb-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelling}
            aria-label={cancelling ? 'Cancelling generation' : 'Cancel generation'}
            className="w-full rounded-xl border border-danger-base/20 bg-danger-light py-2 text-sm font-semibold text-danger-base transition-all hover:bg-red-100 disabled:opacity-60"
          >
            {cancelling ? 'Cancelling…' : 'Cancel generation'}
          </button>
        </div>
      )}

      {cancelMessage && (
        <p
          role="status"
          className="mb-4 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
        >
          {cancelMessage}
        </p>
      )}

      {cancelError && (
        <p
          role="alert"
          className="mb-4 rounded-lg bg-danger-light px-4 py-3 text-sm text-danger-base"
        >
          {cancelError}
        </p>
      )}

      {isDraft && missingFields.length > 0 && (
        <p className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Complete all fields to generate: {missingFields.join(', ')}.
        </p>
      )}

      {generateError && (
        <p
          role="alert"
          className="mb-4 rounded-lg bg-danger-light px-4 py-3 text-sm text-danger-base"
        >
          {generateError}
          {generateInsufficientCredits && !homeMode && (
            <>
              {' '}
              <Link
                href="/dashboard/credits"
                className="font-semibold underline hover:no-underline"
              >
                Buy more credits
              </Link>
            </>
          )}
        </p>
      )}

      {isDraft && (
        <div className="mb-3">
          {canGenerate && <GenerationEstimatePanel bookId={book.id} kind="initial" />}
          <div className="flex gap-3">
            <button
              onClick={onGenerate}
              disabled={!canGenerate || generating}
              className="flex-1 rounded-xl bg-violet-600 py-2 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500 disabled:opacity-60"
            >
              {generating ? 'Generating…' : 'Generate Story'}
            </button>
          </div>
        </div>
      )}

      {canEditOrDelete && (
        <div className="flex gap-3">
          <button
            onClick={onEdit}
            className="flex-1 rounded-xl border border-border-default py-2 text-sm font-semibold text-text-secondary transition-all hover:bg-stone-100"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            disabled={deleting}
            className="flex-1 rounded-xl border border-danger-base/20 bg-danger-light py-2 text-sm font-semibold text-danger-base transition-all hover:bg-red-100 disabled:opacity-60"
          >
            {deleting ? '…' : 'Delete'}
          </button>
        </div>
      )}
    </div>
  );
}

// ── BookPreviewSection ────────────────────────────────────────────────────────

export { BookDetailSkeleton, NotFoundState } from './book-detail/states';
