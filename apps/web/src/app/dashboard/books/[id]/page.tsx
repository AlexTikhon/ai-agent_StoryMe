'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { SupportedLanguage, BookStatus } from '@book/types';
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
import { ApiError } from '@/lib/api/client';

// ── Constants ─────────────────────────────────────────────────────────────────

const LANGUAGES: { value: SupportedLanguage; label: string }[] = [
  { value: SupportedLanguage.English, label: 'English' },
  { value: SupportedLanguage.Russian, label: 'Russian' },
  { value: SupportedLanguage.Polish, label: 'Polish' },
];

const inputCls =
  'rounded-lg border border-border-default bg-white px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-violet-600 focus:outline-none focus:ring-1 focus:ring-violet-600';

const POLL_INTERVAL_MS = 2500;

function isTerminalBookStatus(status: BookStatus): boolean {
  return (
    status === BookStatus.Complete ||
    status === BookStatus.Failed ||
    status === BookStatus.Cancelled ||
    status === BookStatus.Partial
  );
}

function isGeneratingBookStatus(status: BookStatus): boolean {
  return status !== BookStatus.Created && !isTerminalBookStatus(status);
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

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

// ── Types ─────────────────────────────────────────────────────────────────────

interface EditForm {
  childName: string;
  childAge: number;
  language: SupportedLanguage;
  theme: string;
}

function formFromBook(book: BookDto): EditForm {
  return {
    childName: book.childName ?? '',
    childAge: book.childAge ?? 4,
    language: book.language ?? SupportedLanguage.English,
    theme: book.theme ?? '',
  };
}

function validateEdit(form: EditForm): string | null {
  if (!form.childName.trim()) return "Child's name is required";
  if (form.childAge < 1 || form.childAge > 12) return 'Age must be between 1 and 12';
  if (!form.theme.trim()) return 'Theme is required';
  return null;
}

function getMissingDraftFields(book: BookDto): string[] {
  const missing: string[] = [];
  if (!book.childName) missing.push('child name');
  if (book.childAge == null) missing.push('age');
  if (!book.language) missing.push('language');
  if (!book.theme) missing.push('theme');
  return missing;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BookDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();

  const [book, setBook] = useState<BookDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<EditForm>({
    childName: '',
    childAge: 4,
    language: SupportedLanguage.English,
    theme: '',
  });
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [deleting, setDeleting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const [diagnostics, setDiagnostics] = useState<GenerationDiagnosticsDto | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setNotFound(false);
    setBook(null);

    booksApi
      .get(id)
      .then((data) => {
        if (!cancelled) {
          setBook(data);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          if (err instanceof ApiError && err.status === 404) {
            setNotFound(true);
          } else {
            setLoadError(err instanceof Error ? err.message : 'Failed to load book');
          }
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  // Poll while book is in a non-terminal generation state
  useEffect(() => {
    if (!book || !isGeneratingBookStatus(book.status)) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void booksApi
        .get(id)
        .then((data) => {
          if (!cancelled) setBook(data);
        })
        .catch(() => {});
      void booksApi
        .getGenerationDiagnostics(id)
        .then((data) => {
          if (!cancelled) {
            setDiagnostics(data);
            setDiagnosticsError(null);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setDiagnosticsError(err instanceof Error ? err.message : 'Failed to load diagnostics');
          }
        });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, book?.status]);

  // Fetch diagnostics once generation has started (not for untouched drafts)
  useEffect(() => {
    if (!book || book.status === BookStatus.Created) return;
    let cancelled = false;
    booksApi
      .getGenerationDiagnostics(id)
      .then((data) => {
        if (!cancelled) {
          setDiagnostics(data);
          setDiagnosticsError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDiagnosticsError(err instanceof Error ? err.message : 'Failed to load diagnostics');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, book?.status]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const data = await booksApi.get(id);
      setBook(data);
      try {
        const diagnosticsData = await booksApi.getGenerationDiagnostics(id);
        setDiagnostics(diagnosticsData);
        setDiagnosticsError(null);
      } catch (err) {
        setDiagnosticsError(err instanceof Error ? err.message : 'Failed to load diagnostics');
      }
    } catch {
      // silent — manual retry; load errors handled by main effect
    } finally {
      setRefreshing(false);
    }
  };

  const startEdit = () => {
    if (!book) return;
    setEditForm(formFromBook(book));
    setEditError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditError(null);
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    const validationErr = validateEdit(editForm);
    if (validationErr) {
      setEditError(validationErr);
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      const updated = await booksApi.update(id, {
        title: `${editForm.childName.trim()}'s Story`,
        ...editForm,
      });
      setBook(updated);
      setEditing(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update book');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this draft? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await booksApi.remove(id);
      router.push('/dashboard');
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to delete book');
      setDeleting(false);
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      const response = await booksApi.generate(id);
      setBook(response.book);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Failed to start generation');
    } finally {
      setGenerating(false);
    }
  };

  const handleRetry = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      const response = await booksApi.retryGeneration(id);
      setBook(response.book);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Failed to retry generation');
    } finally {
      setRetrying(false);
    }
  };

  return (
    <main className="min-h-dvh bg-bg-base px-4 py-10">
      <div className="mx-auto max-w-lg">
        <Link
          href="/dashboard"
          className="mb-8 inline-flex items-center gap-1 text-sm font-medium text-text-muted hover:text-text-primary"
        >
          ← My Book Drafts
        </Link>

        {loading && <BookDetailSkeleton />}

        {!loading && notFound && <NotFoundState />}

        {!loading && loadError && (
          <div
            role="alert"
            className="mt-8 rounded-xl border border-danger-base/20 bg-danger-light px-5 py-4"
          >
            <p className="text-sm text-danger-base">{loadError}</p>
          </div>
        )}

        {!loading && book && (
          <>
            <h1 className="mb-6 mt-4 font-display text-3xl font-bold text-text-primary">
              {book.title ?? 'Untitled'}
            </h1>

            <div className="rounded-2xl border border-border-default bg-bg-surface p-6 shadow-sm">
              {editing ? (
                <form
                  onSubmit={(e) => {
                    void handleSave(e);
                  }}
                >
                  <h2 className="mb-5 font-display text-xl font-semibold text-text-primary">
                    Edit Book
                  </h2>
                  {editError && (
                    <p
                      role="alert"
                      className="mb-4 rounded-lg bg-danger-light px-4 py-3 text-sm text-danger-base"
                    >
                      {editError}
                    </p>
                  )}
                  <EditFormFields
                    values={editForm}
                    onChange={setEditForm}
                    submitting={saving}
                    onCancel={cancelEdit}
                  />
                </form>
              ) : (
                <BookDetailView
                  book={book}
                  onEdit={startEdit}
                  onDelete={() => {
                    void handleDelete();
                  }}
                  deleting={deleting}
                  onGenerate={() => {
                    void handleGenerate();
                  }}
                  generating={generating}
                  generateError={generateError}
                  onRefresh={() => {
                    void handleRefresh();
                  }}
                  refreshing={refreshing}
                  diagnostics={diagnostics}
                  diagnosticsError={diagnosticsError}
                  onRetry={() => {
                    void handleRetry();
                  }}
                  retrying={retrying}
                  retryError={retryError}
                />
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
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
  onRefresh: () => void;
  refreshing: boolean;
  diagnostics: GenerationDiagnosticsDto | null;
  diagnosticsError: string | null;
  onRetry: () => void;
  retrying: boolean;
  retryError: string | null;
}

function BookDetailView({
  book,
  onEdit,
  onDelete,
  deleting,
  onGenerate,
  generating,
  generateError,
  onRefresh,
  refreshing,
  diagnostics,
  diagnosticsError,
  onRetry,
  retrying,
  retryError,
}: BookDetailViewProps) {
  const isDraft = book.status === BookStatus.Created;
  const missingFields = getMissingDraftFields(book);
  const canGenerate = isDraft && missingFields.length === 0;
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
            isDraft ? 'bg-stone-100 text-text-muted' : 'bg-violet-50 text-violet-700'
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

      {book.status === BookStatus.Failed && (
        <div className="mb-6">
          <button
            onClick={onRetry}
            disabled={retrying}
            className="w-full rounded-xl bg-violet-600 py-2 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500 disabled:opacity-60"
          >
            {retrying ? 'Retrying…' : 'Retry generation'}
          </button>
          {retryError && (
            <p
              role="alert"
              className="mt-2 rounded-lg bg-danger-light px-4 py-3 text-sm text-danger-base"
            >
              {retryError}
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
        </p>
      )}

      {isDraft && (
        <>
          <div className="mb-3 flex gap-3">
            <button
              onClick={onGenerate}
              disabled={!canGenerate || generating}
              className="flex-1 rounded-xl bg-violet-600 py-2 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500 disabled:opacity-60"
            >
              {generating ? 'Generating…' : 'Generate Story'}
            </button>
          </div>

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
        </>
      )}
    </div>
  );
}

// ── GenerationDiagnosticsPanel ────────────────────────────────────────────────

function GenerationDiagnosticsPanel({
  diagnostics,
  diagnosticsError,
}: {
  diagnostics: GenerationDiagnosticsDto | null;
  diagnosticsError: string | null;
}) {
  if (!diagnostics && !diagnosticsError) return null;

  if (!diagnostics) {
    return (
      <div className="mb-6 rounded-xl border border-border-default bg-stone-50 p-4 text-xs text-text-muted">
        Diagnostics unavailable{diagnosticsError ? `: ${diagnosticsError}` : '.'}
      </div>
    );
  }

  // generationMetadata is always present per the DTO contract, but panel stays
  // resilient to a malformed/partial payload rather than throwing during render.
  const meta = diagnostics.generationMetadata ?? ({} as Partial<GenerationDiagnosticsDto['generationMetadata']>);
  const hasFailure = Boolean(diagnostics.failedStep ?? diagnostics.errorMessage);

  return (
    <div
      data-testid="generation-diagnostics"
      className="mb-6 rounded-xl border border-border-default bg-stone-50 p-4"
    >
      <h2 className="mb-3 font-display text-sm font-semibold text-text-secondary">
        Generation diagnostics
      </h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-muted">
        {meta.storyProvider && (
          <div>
            <dt className="inline font-medium">Story: </dt>
            <dd className="inline text-text-secondary">
              {meta.storyProvider}
              {meta.storyModel ? ` (${meta.storyModel})` : ''}
            </dd>
          </div>
        )}
        {meta.imageProvider && (
          <div>
            <dt className="inline font-medium">Images: </dt>
            <dd className="inline text-text-secondary">
              {meta.imageProvider}
              {meta.imageModel ? ` (${meta.imageModel})` : ''}
            </dd>
          </div>
        )}
        {meta.generatedPages !== undefined && (
          <div>
            <dt className="inline font-medium">Generated pages: </dt>
            <dd className="inline text-text-secondary">
              {meta.generatedPages}
              {meta.requestedPages != null ? ` / ${meta.requestedPages}` : ''}
            </dd>
          </div>
        )}
        {meta.durationMs !== undefined && (
          <div>
            <dt className="inline font-medium">Duration: </dt>
            <dd className="inline text-text-secondary">{formatDurationMs(meta.durationMs)}</dd>
          </div>
        )}
        {diagnostics.previewPdfUrl && (
          <div>
            <dt className="inline font-medium">PDF: </dt>
            <dd className="inline text-text-secondary">ready</dd>
          </div>
        )}
      </dl>

      {hasFailure && (
        <div className="mt-3 rounded-lg bg-danger-light px-3 py-2 text-xs text-danger-base">
          {diagnostics.failedStep && (
            <p>
              <span className="font-medium">Failed step:</span> {diagnostics.failedStep}
            </p>
          )}
          {diagnostics.errorMessage && <p>{diagnostics.errorMessage}</p>}
          <p className="mt-1 text-text-muted">
            Try again later, or check diagnostics for more detail.
          </p>
        </div>
      )}
    </div>
  );
}

// ── BookPreviewSection ────────────────────────────────────────────────────────

function BookPreviewSection({ preview }: { preview: BookPreview }) {
  return (
    <div className="mb-6 rounded-xl border border-teal-100 bg-teal-50 p-4">
      <h2 className="mb-3 font-display text-base font-semibold text-teal-800">
        Book preview is ready
      </h2>

      <div className="mb-4 rounded-lg border border-teal-100 bg-white p-3 text-sm">
        <p className="mb-0.5 font-semibold text-text-primary">{preview.title}</p>
        <p className="mb-2 text-xs text-text-muted">{preview.subtitle}</p>
        <div className="mb-1 text-xs text-teal-700">
          <span className="font-medium">Cover illustration:</span>{' '}
          {preview.cover.illustrationPrompt}
        </div>
      </div>

      <ul className="mb-4 space-y-3">
        {preview.pages.map((page) => (
          <BookPreviewPageItem key={page.pageNumber} page={page} />
        ))}
      </ul>

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
          <dt className="inline font-medium">Provider: </dt>
          <dd className="inline text-text-secondary">{result.provider}</dd>
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

// ── EditFormFields ────────────────────────────────────────────────────────────

interface EditFormFieldsProps {
  values: EditForm;
  onChange: (v: EditForm) => void;
  submitting: boolean;
  onCancel: () => void;
}

function EditFormFields({ values, onChange, submitting, onCancel }: EditFormFieldsProps) {
  const set = (patch: Partial<EditForm>) => onChange({ ...values, ...patch });

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text-secondary">
            Child&apos;s name{' '}
            <span className="text-danger-base" aria-hidden="true">
              *
            </span>
          </span>
          <input
            value={values.childName}
            onChange={(e) => set({ childName: e.target.value })}
            placeholder="e.g. Emma"
            maxLength={80}
            className={inputCls}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text-secondary">
            Age{' '}
            <span className="text-danger-base" aria-hidden="true">
              *
            </span>
          </span>
          <input
            type="number"
            min={1}
            max={12}
            value={values.childAge}
            onChange={(e) => set({ childAge: Number(e.target.value) })}
            className={inputCls}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text-secondary">
            Language{' '}
            <span className="text-danger-base" aria-hidden="true">
              *
            </span>
          </span>
          <select
            value={values.language}
            onChange={(e) => set({ language: e.target.value as SupportedLanguage })}
            className={inputCls}
          >
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text-secondary">
            Theme{' '}
            <span className="text-danger-base" aria-hidden="true">
              *
            </span>
          </span>
          <input
            value={values.theme}
            onChange={(e) => set({ theme: e.target.value })}
            placeholder="e.g. Friendship and courage"
            maxLength={120}
            className={inputCls}
          />
        </label>
      </div>

      <div className="mt-5 flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-violet-600 px-5 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500 disabled:opacity-60"
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-10 items-center rounded-xl border border-border-default px-5 text-sm font-semibold text-text-primary transition-all hover:bg-stone-100"
        >
          Cancel
        </button>
      </div>
    </>
  );
}

// ── PdfSection ────────────────────────────────────────────────────────────────

function PdfSection({ book }: { book: BookDto }) {
  const pdfApiUrl =
    book.status === BookStatus.Complete && book.previewPdfUrl
      ? bookPdfPreviewUrl(book.id)
      : null;

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
    if (pdfApiUrl) {
      return (
        <div className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <h2 className="mb-1 font-display text-base font-semibold text-emerald-800">
            Your PDF is ready
          </h2>
          <p className="mb-4 text-xs text-emerald-600">Preview PDF · locally generated file</p>
          <div className="flex gap-3">
            <a
              href={pdfApiUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 items-center rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500"
            >
              Open PDF
            </a>
            <a
              href={pdfApiUrl}
              download={`storyme-preview-${book.id}.pdf`}
              className="inline-flex h-9 items-center rounded-xl border border-border-default px-4 text-sm font-semibold text-text-secondary transition-all hover:bg-stone-100"
            >
              Download PDF
            </a>
          </div>
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

  if (book.status === BookStatus.Failed) {
    return (
      <div className="mb-6 rounded-xl border border-danger-base/20 bg-danger-light p-4">
        <p className="text-sm text-danger-base">Generation failed. Please contact support.</p>
      </div>
    );
  }

  return null;
}

// ── Skeleton / Not Found ──────────────────────────────────────────────────────

function BookDetailSkeleton() {
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

function NotFoundState() {
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
