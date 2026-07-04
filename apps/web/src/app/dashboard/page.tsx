'use client';

import Link from 'next/link';
import { useEffect, useState, useCallback } from 'react';
import type { BookDto } from '@book/types';
import { BookStatus } from '@book/types';
import { booksApi } from '@/lib/api/books';

/** Books not actively running the generation pipeline — safe to edit/delete. Mirrors the API's EDITABLE_BOOK_STATUSES gate. */
function isBookEditable(status: BookStatus): boolean {
  return (
    status === BookStatus.Created ||
    status === BookStatus.Complete ||
    status === BookStatus.Failed ||
    status === BookStatus.Partial ||
    status === BookStatus.Cancelled
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [books, setBooks] = useState<BookDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadBooks = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await booksApi.list();
      setBooks(data.items);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load books');
    }
  }, []);

  useEffect(() => {
    void loadBooks();
  }, [loadBooks]);

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this book? This cannot be undone.')) return;
    setDeletingId(id);
    try {
      await booksApi.remove(id);
      setBooks((prev) => prev?.filter((b) => b.id !== id) ?? null);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to delete book');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <main className="min-h-dvh bg-bg-base px-4 py-10">
      <div className="mx-auto max-w-container-lg">
        {/* ── Header ── */}
        <div className="mb-8 flex items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl font-bold text-text-primary">My Book Drafts</h1>
          </div>
          <Link
            href="/dashboard/books/new"
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl bg-violet-600 px-5 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500 focus-visible:ring-2 focus-visible:ring-violet-600 focus-visible:ring-offset-2"
          >
            <span aria-hidden="true">+</span> New Book
          </Link>
        </div>

        {/* ── List states ── */}
        {books === null && !loadError && <BookListSkeleton />}

        {loadError && (
          <ErrorBanner
            message={loadError}
            onRetry={() => {
              void loadBooks();
            }}
          />
        )}

        {books !== null && books.length === 0 && <EmptyState />}

        {books !== null && books.length > 0 && (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Book drafts">
            {books.map((book) => (
              <li key={book.id}>
                <BookCard
                  book={book}
                  onDelete={() => {
                    void handleDelete(book.id);
                  }}
                  deleting={deletingId === book.id}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

// ── BookCard ──────────────────────────────────────────────────────────────────

interface BookCardProps {
  book: BookDto;
  onDelete: () => void;
  deleting: boolean;
}

function BookCard({ book, onDelete, deleting }: BookCardProps) {
  const isDraft = book.status === BookStatus.Created;
  const editable = isBookEditable(book.status);

  return (
    <div className="flex h-full flex-col rounded-2xl border border-border-subtle bg-bg-surface p-5 shadow-xs transition-shadow hover:shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-2">
        <Link
          href={`/dashboard/books/${book.id}`}
          className="font-display text-lg font-semibold leading-snug text-text-primary transition-colors hover:text-violet-700"
        >
          {book.title ?? 'Untitled'}
        </Link>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            isDraft ? 'bg-stone-100 text-text-muted' : 'bg-violet-50 text-violet-700'
          }`}
        >
          {book.status}
        </span>
      </div>

      <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {book.childName && (
          <>
            <dt className="text-text-muted">For</dt>
            <dd className="font-medium text-text-secondary">
              {book.childName}, age {book.childAge}
            </dd>
          </>
        )}
        {book.language && (
          <>
            <dt className="text-text-muted">Language</dt>
            <dd className="font-medium text-text-secondary">{book.language}</dd>
          </>
        )}
        {book.theme && (
          <>
            <dt className="text-text-muted">Theme</dt>
            <dd className="font-medium text-text-secondary">{book.theme}</dd>
          </>
        )}
      </dl>

      <p className="mb-4 mt-auto text-xs text-text-muted">
        Created {new Date(book.createdAt).toLocaleDateString()}
      </p>

      <div className="flex gap-2">
        <Link
          href={`/dashboard/books/${book.id}`}
          className="flex-1 rounded-lg border border-border-default py-1.5 text-center text-sm font-medium text-text-secondary transition-all hover:bg-stone-100"
        >
          {isDraft ? 'Edit' : 'View'}
        </Link>
        <button
          onClick={onDelete}
          disabled={deleting || !editable}
          className="flex-1 rounded-lg border border-danger-base/20 bg-danger-light py-1.5 text-sm font-medium text-danger-base transition-all hover:bg-red-100 disabled:opacity-60"
        >
          {deleting ? '…' : 'Delete'}
        </button>
      </div>
    </div>
  );
}

// ── Skeleton / Empty / Error ──────────────────────────────────────────────────

function BookListSkeleton() {
  return (
    <ul
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      aria-label="Loading book drafts"
      aria-busy="true"
    >
      {[1, 2, 3].map((i) => (
        <li key={i} className="h-52 rounded-2xl skeleton" />
      ))}
    </ul>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-border-default py-20 text-center">
      <p className="mb-2 text-lg font-semibold text-text-primary">No book drafts yet</p>
      <p className="mb-6 text-sm text-text-muted">Create your first personalized story</p>
      <Link
        href="/dashboard/books/new"
        className="inline-flex h-10 items-center gap-2 rounded-xl bg-violet-600 px-5 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500"
      >
        <span aria-hidden="true">+</span> Create First Book
      </Link>
    </div>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between rounded-xl border border-danger-base/20 bg-danger-light px-5 py-4"
    >
      <p className="text-sm text-danger-base">{message}</p>
      <button onClick={onRetry} className="text-sm font-semibold text-danger-base underline">
        Retry
      </button>
    </div>
  );
}
