import Link from 'next/link';

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
