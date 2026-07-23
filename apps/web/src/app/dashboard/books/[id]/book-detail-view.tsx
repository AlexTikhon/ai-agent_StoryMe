import Link from 'next/link';
import { useState, type MouseEvent } from 'react';
import { BookStatus } from '@book/types';
import type {
  BookDto,
  BookLayout,
  BookLayoutEntry,
  BookPreview,
  BookPreviewPage,
  GeneratedImageEntry,
  GenerationDiagnosticsDto,
  IllustrationPlan,
  ImageGenerationResult,
  PagePlan,
} from '@book/types';
import { booksApi, bookPdfPreviewUrl } from '@/lib/api/books';
import { safePdfFilename } from '@/lib/pdf-filename';
import { GenerationDiagnosticsPanel } from './generation-diagnostics-panel';
import { isGeneratingBookStatus } from './use-book-detail';

function generationStatusMessage(status: BookStatus): string {
  switch (status) {
    case BookStatus.CharBuild:
      return 'Building character profile…';
    case BookStatus.StoryPlan:
      return 'Planning your story…';
    case BookStatus.PagePlan:
      return 'Planning pages…';
    case BookStatus.StoryDraft:
      return 'Writing your story…';
    case BookStatus.ChapterGen:
      return 'Writing chapters…';
    case BookStatus.IllustPlan:
      return 'Planning illustrations…';
    case BookStatus.PreviewReady:
      return 'Preparing preview…';
    case BookStatus.ImageGen:
      return 'Generating images…';
    case BookStatus.QaReview:
      return 'Reviewing quality…';
    case BookStatus.Layout:
      return 'Designing book pages…';
    case BookStatus.PdfRender:
      return 'Rendering PDF…';
    default:
      return 'Generation in progress…';
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

interface BookDetailViewProps {
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
  diagnostics: GenerationDiagnosticsDto | null;
  diagnosticsError: string | null;
  onRegenerate: () => void;
  retrying: boolean;
  retryError: string | null;
  retryInsufficientCredits: boolean;
  justEdited: boolean;
  onCancel: () => void;
  cancelling: boolean;
  cancelError: string | null;
  cancelMessage: string | null;
}

export function BookDetailView({
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
  diagnostics,
  diagnosticsError,
  onRegenerate,
  retrying,
  retryError,
  retryInsufficientCredits,
  justEdited,
  onCancel,
  cancelling,
  cancelError,
  cancelMessage,
}: BookDetailViewProps) {
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

      {!isDraft && (
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
              {retryInsufficientCredits && (
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

      {storyPlan && (
        <div className="mb-6 rounded-xl border border-violet-100 bg-violet-50 p-4">
          <h2 className="mb-1 font-display text-base font-semibold text-violet-800">
            Story plan is ready
          </h2>
          <p className="mb-1 text-sm font-medium text-violet-700">{storyPlan.title}</p>
          <p className="mb-3 text-xs text-violet-600">{storyPlan.educationalMessage}</p>
          <ul className="space-y-1.5">
            {storyPlan.chapters.map((ch) => (
              <li key={ch.chapterNumber} className="text-sm">
                <span className="font-medium text-text-primary">{ch.title}</span>
                <span className="text-text-muted"> — {ch.summary}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pages && (
        <div className="mb-6 rounded-xl border border-indigo-100 bg-indigo-50 p-4">
          <h2 className="mb-3 font-display text-base font-semibold text-indigo-800">
            Page plan is ready
          </h2>
          <ul className="space-y-3">
            {pages.map((page) => (
              <li
                key={page.pageNumber}
                className="rounded-lg border border-indigo-100 bg-white p-3 text-sm"
              >
                <div className="mb-1 flex items-center gap-2">
                  <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">
                    Page {page.pageNumber}
                  </span>
                  <span className="text-xs text-text-muted">Chapter {page.chapterIndex + 1}</span>
                </div>
                <p className="mb-0.5 font-medium text-text-primary">{page.title}</p>
                <p className="mb-0.5 text-text-secondary">{page.sceneDescription}</p>
                <p className="mb-0.5 text-text-muted italic">{page.narration}</p>
                <p className="mb-0.5 text-xs text-indigo-600">
                  <span className="font-medium">Illustration:</span> {page.illustrationPrompt}
                </p>
                <p className="text-xs text-indigo-500">
                  <span className="font-medium">Learning goal:</span> {page.learningGoal}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {draftPages && draftPages.length > 0 && (
        <div className="mb-6 rounded-xl border border-emerald-100 bg-emerald-50 p-4">
          <h2 className="mb-3 font-display text-base font-semibold text-emerald-800">
            Story draft is ready
          </h2>
          <ul className="space-y-3">
            {draftPages.map((page) => (
              <li
                key={page.pageNumber}
                className="rounded-lg border border-emerald-100 bg-white p-3 text-sm"
              >
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                    Page {page.pageNumber}
                  </span>
                  <span className="font-medium text-text-primary">{page.title}</span>
                </div>
                <p className="leading-relaxed text-text-secondary">{page.storyText}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {illustrationPages && illustrationPages.length > 0 && (
        <div className="mb-6 rounded-xl border border-amber-100 bg-amber-50 p-4">
          <h2 className="mb-3 font-display text-base font-semibold text-amber-800">
            Illustration plan is ready
          </h2>
          <ul className="space-y-3">
            {illustrationPages.map((page) => (
              <li
                key={page.pageNumber}
                className="rounded-lg border border-amber-100 bg-white p-3 text-sm"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                    Page {page.pageNumber}
                  </span>
                </div>
                <IllustrationPlanDetail illust={page.illustration as IllustrationPlan} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {bookPreview && <BookPreviewSection preview={bookPreview} />}

      {imageGenerationResult && <ImageGenerationSection result={imageGenerationResult} />}

      {bookLayout && <BookLayoutSection layout={bookLayout} />}

      <PdfSection book={book} />

      {!isDraft && isGeneratingBookStatus(book.status) && (
        <p className="mb-4 rounded-lg bg-violet-50 px-4 py-3 text-sm text-violet-700">
          {generationStatusMessage(book.status)} This draft can no longer be edited.
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
          {generateInsufficientCredits && (
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
        <div className="mb-3 flex gap-3">
          <button
            onClick={onGenerate}
            disabled={!canGenerate || generating}
            className="flex-1 rounded-xl bg-violet-600 py-2 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500 disabled:opacity-60"
          >
            {generating ? 'Generating…' : 'Generate Story'}
          </button>
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

function BookPreviewSection({ preview }: { preview: BookPreview }) {
  const previewPages = Array.isArray(preview.pages) ? preview.pages : [];

  return (
    <div className="mb-6 rounded-xl border border-teal-100 bg-teal-50 p-4">
      <h2 className="mb-3 font-display text-base font-semibold text-teal-800">
        Generated story preview
      </h2>

      <div className="mb-4 rounded-lg border border-teal-100 bg-white p-3 text-sm">
        <p className="mb-0.5 font-semibold text-text-primary">{preview.title}</p>
        <p className="mb-2 text-xs text-text-muted">{preview.subtitle}</p>
        <div className="mb-1 text-xs text-teal-700">
          <span className="font-medium">Cover illustration:</span>{' '}
          {preview.cover.illustrationPrompt}
        </div>
      </div>

      {previewPages.length > 0 ? (
        <ul className="mb-4 space-y-3">
          {previewPages.map((page) => (
            <BookPreviewPageItem key={page.pageNumber} page={page} />
          ))}
        </ul>
      ) : (
        <p className="mb-4 rounded-lg border border-teal-100 bg-white p-3 text-sm text-text-muted">
          No pages were generated for this preview yet.
        </p>
      )}

      <div className="mb-3 rounded-lg border border-teal-100 bg-white p-3 text-sm">
        <p className="mb-0.5 font-medium text-text-primary">Back cover</p>
        <p className="mb-1 text-text-secondary">{preview.backCover.message}</p>
        <p className="text-xs text-text-muted">{preview.backCover.educationalSummary}</p>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-muted">
        <div>
          <dt className="inline font-medium">Language: </dt>
          <dd className="inline">{preview.metadata.language}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Theme: </dt>
          <dd className="inline">{preview.metadata.theme}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Age: </dt>
          <dd className="inline">{preview.metadata.childAge}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Pages: </dt>
          <dd className="inline">{preview.metadata.totalPages}</dd>
        </div>
      </dl>
    </div>
  );
}

function BookPreviewPageItem({ page }: { page: BookPreviewPage }) {
  return (
    <li className="rounded-lg border border-teal-100 bg-white p-3 text-sm">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="rounded-full bg-teal-100 px-2 py-0.5 text-xs font-semibold text-teal-700">
          Page {page.pageNumber}
        </span>
        <span className="text-xs text-text-muted">{page.layout}</span>
      </div>
      <p className="mb-0.5 font-medium text-text-primary">{page.title}</p>
      <p className="mb-1 leading-relaxed text-text-secondary">{page.text}</p>
      <p className="mb-0.5 text-xs text-teal-600">
        <span className="font-medium">Illustration:</span> {page.illustrationPrompt}
      </p>
      <p className="text-xs text-teal-500">
        <span className="font-medium">Learning goal:</span> {page.learningGoal}
      </p>
    </li>
  );
}

// ── ImageGenerationSection ────────────────────────────────────────────────────

function ImageGenerationSection({ result }: { result: ImageGenerationResult }) {
  const coverImage = result.images.find((img) => img.kind === 'cover');
  const pageImages = result.images.filter((img) => img.kind === 'page');
  const backCoverImage = result.images.find((img) => img.kind === 'back_cover');

  return (
    <div className="mb-6 rounded-xl border border-sky-100 bg-sky-50 p-4">
      <h2 className="mb-3 font-display text-base font-semibold text-sky-800">Images are ready</h2>

      <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-muted">
        <div>
          <dt className="inline font-medium">Rendered by: </dt>
          <dd className="inline text-text-secondary">{result.imageByteProvider ?? 'unknown'}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Status: </dt>
          <dd className="inline text-text-secondary">{result.status}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Total images: </dt>
          <dd className="inline text-text-secondary">{result.images.length}</dd>
        </div>
      </dl>

      <ul className="space-y-2">
        {coverImage && <ImageEntryCard image={coverImage} />}
        {pageImages.map((img) => (
          <ImageEntryCard key={img.id} image={img} />
        ))}
        {backCoverImage && <ImageEntryCard image={backCoverImage} />}
      </ul>
    </div>
  );
}

function ImageEntryCard({ image }: { image: GeneratedImageEntry }) {
  const kindLabel =
    image.kind === 'cover'
      ? 'Cover'
      : image.kind === 'back_cover'
        ? 'Back Cover'
        : `Page ${image.pageNumber}`;

  return (
    <li className="rounded-lg border border-sky-100 bg-white p-3 text-xs">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-700">
          {kindLabel}
        </span>
        <span className="font-mono text-text-muted">{image.imageUrl}</span>
      </div>
      <p className="mb-0.5 text-text-muted">
        <span className="font-medium">Alt: </span>
        <span className="text-text-secondary">{image.altText}</span>
      </p>
      <p className="text-text-muted">
        <span className="font-medium">Size: </span>
        <span className="text-text-secondary">
          {image.width}×{image.height}px
        </span>
      </p>
    </li>
  );
}

// ── BookLayoutSection ─────────────────────────────────────────────────────────

function BookLayoutSection({ layout }: { layout: BookLayout }) {
  const coverEntry = layout.entries.find((e) => e.kind === 'cover');
  const pageEntries = layout.entries.filter((e) => e.kind === 'page');
  const backCoverEntry = layout.entries.find((e) => e.kind === 'back_cover');

  return (
    <div className="mb-6 rounded-xl border border-rose-100 bg-rose-50 p-4">
      <h2 className="mb-3 font-display text-base font-semibold text-rose-800">Layout is ready</h2>

      <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-muted">
        <div>
          <dt className="inline font-medium">Trim size: </dt>
          <dd className="inline text-text-secondary">{layout.trimSize}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Status: </dt>
          <dd className="inline text-text-secondary">{layout.status}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Pages: </dt>
          <dd className="inline text-text-secondary">{layout.metadata.totalPages}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Entries: </dt>
          <dd className="inline text-text-secondary">{layout.entries.length}</dd>
        </div>
      </dl>

      <ul className="space-y-2">
        {coverEntry && <LayoutEntryCard entry={coverEntry} />}
        {pageEntries.map((entry) => (
          <LayoutEntryCard key={entry.id} entry={entry} />
        ))}
        {backCoverEntry && <LayoutEntryCard entry={backCoverEntry} />}
      </ul>
    </div>
  );
}

function LayoutEntryCard({ entry }: { entry: BookLayoutEntry }) {
  const kindLabel =
    entry.kind === 'cover'
      ? 'Cover'
      : entry.kind === 'back_cover'
        ? 'Back Cover'
        : `Page ${entry.pageNumber}`;

  return (
    <li className="rounded-lg border border-rose-100 bg-white p-3 text-xs">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">
          {kindLabel}
        </span>
        <span className="font-mono text-text-muted">{entry.template}</span>
      </div>
      <p className="mb-0.5 text-text-muted">
        <span className="font-medium">Canvas: </span>
        <span className="text-text-secondary">
          {entry.canvas.width}×{entry.canvas.height}
          {entry.canvas.unit}
        </span>
      </p>
      {entry.imageBlock && (
        <p className="mb-0.5 text-text-muted">
          <span className="font-medium">Image: </span>
          <span className="font-mono text-text-secondary">{entry.imageBlock.imageUrl}</span>
        </p>
      )}
      {entry.textBlock && (
        <p className="text-text-muted">
          <span className="font-medium">Text: </span>
          <span className="text-text-secondary">
            {entry.textBlock.text.slice(0, 80)}
            {entry.textBlock.text.length > 80 ? '…' : ''}
          </span>
        </p>
      )}
    </li>
  );
}

// ── IllustrationPlanDetail ────────────────────────────────────────────────────

function IllustrationPlanDetail({ illust }: { illust: IllustrationPlan }) {
  return (
    <dl className="space-y-1 text-xs">
      <div>
        <dt className="inline font-medium text-text-muted">Prompt: </dt>
        <dd className="inline text-text-secondary">{illust.prompt}</dd>
      </div>
      <div>
        <dt className="inline font-medium text-text-muted">Negative prompt: </dt>
        <dd className="inline text-text-secondary">{illust.negativePrompt}</dd>
      </div>
      <div>
        <dt className="inline font-medium text-text-muted">Style: </dt>
        <dd className="inline text-text-secondary">{illust.style}</dd>
      </div>
      <div>
        <dt className="inline font-medium text-text-muted">Aspect ratio: </dt>
        <dd className="inline text-text-secondary">{illust.aspectRatio}</dd>
      </div>
      <div>
        <dt className="inline font-medium text-text-muted">Characters: </dt>
        <dd className="inline text-text-secondary">{illust.characters.join(', ')}</dd>
      </div>
      <div>
        <dt className="inline font-medium text-text-muted">Setting: </dt>
        <dd className="inline text-text-secondary">{illust.setting}</dd>
      </div>
      <div>
        <dt className="inline font-medium text-text-muted">Mood: </dt>
        <dd className="inline text-text-secondary">{illust.mood}</dd>
      </div>
      <div>
        <dt className="inline font-medium text-text-muted">Consistency notes: </dt>
        <dd className="inline text-text-secondary">{illust.consistencyNotes}</dd>
      </div>
    </dl>
  );
}

// ── PdfSection ────────────────────────────────────────────────────────────────

function PdfSection({ book }: { book: BookDto }) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const isCancelled = book.status === BookStatus.Cancelled;
  // Cancellation never touches previewPdfUrl/bookPreview (see
  // GenerationRunCoordinator.cancelGeneration) — a PDF published by an
  // earlier successful run survives a later regeneration's cancellation
  // untouched, so it stays visible/downloadable here.
  const pdfApiUrl =
    (book.status === BookStatus.Complete || isCancelled) && book.previewPdfUrl
      ? bookPdfPreviewUrl(book.id)
      : null;
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

  if (book.status === BookStatus.Complete) {
    if (pdfApiUrl) {
      return (
        <div className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <h2 className="mb-1 font-display text-base font-semibold text-emerald-800">
            Your PDF is ready
          </h2>
          <p className="mb-4 text-xs text-emerald-600">Preview PDF · locally generated file</p>
          {pdfActions}
        </div>
      );
    }

    return (
      <div className="mb-6 rounded-xl border border-stone-200 bg-stone-50 p-4">
        <p className="text-sm text-text-muted">
          Book is complete, but PDF link is not available yet.
        </p>
      </div>
    );
  }

  if (isCancelled) {
    if (pdfApiUrl) {
      return (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <h2 className="mb-1 font-display text-base font-semibold text-amber-800">
            Previous PDF still available
          </h2>
          <p className="mb-4 text-xs text-amber-700">
            This generation run was cancelled, but the PDF from an earlier successful run is still
            here.
          </p>
          {pdfActions}
        </div>
      );
    }

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

export function BookDetailSkeleton() {
  return (
    <div role="status" aria-label="Loading book" className="mt-8 space-y-4">
      <div className="h-9 w-64 rounded-xl skeleton" />
      <div className="rounded-2xl border border-border-default bg-bg-surface p-6">
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-5 w-full rounded skeleton" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function NotFoundState() {
  return (
    <div className="mt-8 text-center">
      <h1 className="mb-2 font-display text-2xl font-bold text-text-primary">Book not found</h1>
      <p className="mb-6 text-sm text-text-muted">
        This book does not exist or you do not have access to it.
      </p>
      <Link
        href="/dashboard"
        className="inline-flex h-10 items-center gap-2 rounded-xl bg-violet-600 px-5 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500"
      >
        ← Back to my drafts
      </Link>
    </div>
  );
}
