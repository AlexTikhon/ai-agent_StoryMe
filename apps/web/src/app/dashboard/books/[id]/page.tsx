'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { BookStatus } from '@book/types';
import { booksApi } from '@/lib/api/books';
import { useBookDetail } from './use-book-detail';
import { defaultEditForm, formFromBook, validateEdit, EditFormFields, type EditForm } from './edit-form';
import { BookDetailView, BookDetailSkeleton, NotFoundState } from './book-detail-view';

export default function BookDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();

  const { book, setBook, loading, loadError, notFound, retryLoad, diagnostics, diagnosticsError, refreshing, handleRefresh } =
    useBookDetail(id);

  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<EditForm>(defaultEditForm());
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justEdited, setJustEdited] = useState(false);

  const [deleting, setDeleting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

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
      const educationalMessage = editForm.educationalMessage.trim();
      const updated = await booksApi.update(id, {
        title: editForm.title,
        childName: editForm.childName,
        childAge: editForm.childAge,
        language: editForm.language,
        theme: editForm.theme,
        pageCount: editForm.pageCount,
        ...(educationalMessage && { educationalMessage }),
      });
      setBook(updated);
      setEditing(false);
      if (updated.status !== BookStatus.Created) {
        setJustEdited(true);
      }
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update book');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this book? This cannot be undone.')) return;
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

  const handleRegenerate = async () => {
    const confirmMessage =
      book?.status === BookStatus.Complete
        ? 'Regenerate this book? This will replace the current story, images, and PDF.'
        : 'Retry generation? This will replace the current story, images, and PDF.';
    if (!window.confirm(confirmMessage)) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const response = await booksApi.retryGeneration(id);
      setBook(response.book);
      setJustEdited(false);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Failed to start regeneration');
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
            className="mt-8 flex items-center justify-between gap-4 rounded-xl border border-danger-base/20 bg-danger-light px-5 py-4"
          >
            <p className="text-sm text-danger-base">{loadError}</p>
            <button
              onClick={retryLoad}
              className="shrink-0 text-sm font-semibold text-danger-base underline"
            >
              Retry
            </button>
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
                  onRegenerate={() => {
                    void handleRegenerate();
                  }}
                  retrying={retrying}
                  retryError={retryError}
                  justEdited={justEdited}
                />
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
