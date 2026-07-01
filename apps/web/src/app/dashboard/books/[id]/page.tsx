'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { SupportedLanguage, BookStatus } from '@book/types';
import type { BookDto, PagePlan } from '@book/types';
import { booksApi } from '@/lib/api/books';
import { ApiError } from '@/lib/api/client';

// ── Constants ─────────────────────────────────────────────────────────────────

const LANGUAGES: { value: SupportedLanguage; label: string }[] = [
  { value: SupportedLanguage.English, label: 'English' },
  { value: SupportedLanguage.Russian, label: 'Russian' },
  { value: SupportedLanguage.Polish, label: 'Polish' },
];

const inputCls =
  'rounded-lg border border-border-default bg-white px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-violet-600 focus:outline-none focus:ring-1 focus:ring-violet-600';

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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setNotFound(false);
    setBook(null);

    booksApi.get(id).then((data) => {
      if (!cancelled) {
        setBook(data);
        setLoading(false);
      }
    }).catch((err: unknown) => {
      if (!cancelled) {
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
        } else {
          setLoadError(err instanceof Error ? err.message : 'Failed to load book');
        }
        setLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [id]);

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
                <form onSubmit={(e) => { void handleSave(e); }}>
                  <h2 className="mb-5 font-display text-xl font-semibold text-text-primary">
                    Edit Book
                  </h2>
                  {editError && (
                    <p role="alert" className="mb-4 rounded-lg bg-danger-light px-4 py-3 text-sm text-danger-base">
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
                  onDelete={() => { void handleDelete(); }}
                  deleting={deleting}
                  onGenerate={() => { void handleGenerate(); }}
                  generating={generating}
                  generateError={generateError}
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
}

function BookDetailView({ book, onEdit, onDelete, deleting, onGenerate, generating, generateError }: BookDetailViewProps) {
  const isDraft = book.status === BookStatus.Created;
  const missingFields = getMissingDraftFields(book);
  const canGenerate = isDraft && missingFields.length === 0;
  const storyPlan = book.storyPlan ?? null;
  const pages: PagePlan[] | undefined =
    storyPlan?.pages && storyPlan.pages.length > 0 ? storyPlan.pages : undefined;

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
          <dd className="text-text-primary">
            {new Date(book.createdAt).toLocaleDateString()}
          </dd>
        </div>
        <div className="flex justify-between py-2.5">
          <dt className="font-medium text-text-muted">Updated</dt>
          <dd className="text-text-primary">
            {new Date(book.updatedAt).toLocaleDateString()}
          </dd>
        </div>
      </dl>

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
              <li key={page.pageNumber} className="rounded-lg border border-indigo-100 bg-white p-3 text-sm">
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

      {!isDraft && (
        <p className="mb-4 rounded-lg bg-violet-50 px-4 py-3 text-sm text-violet-700">
          Generation has started. This draft can no longer be edited.
        </p>
      )}

      {isDraft && missingFields.length > 0 && (
        <p className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Complete all fields to generate: {missingFields.join(', ')}.
        </p>
      )}

      {generateError && (
        <p role="alert" className="mb-4 rounded-lg bg-danger-light px-4 py-3 text-sm text-danger-base">
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
            Child&apos;s name <span className="text-danger-base" aria-hidden="true">*</span>
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
            Age <span className="text-danger-base" aria-hidden="true">*</span>
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
            Language <span className="text-danger-base" aria-hidden="true">*</span>
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
            Theme <span className="text-danger-base" aria-hidden="true">*</span>
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
