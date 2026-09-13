'use client';

import { useAuth } from '@/lib/auth/auth-context';

export function HomeAuthCta() {
  const { status } = useAuth();
  const primaryHref = status === 'authed' ? '/dashboard' : '/register';

  return (
    <>
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
        <a
          href={primaryHref}
          className="inline-flex h-12 items-center justify-center rounded-xl bg-violet-600 px-8 text-base font-semibold text-white shadow-brand transition-all hover:bg-violet-500 focus-visible:ring-2 focus-visible:ring-violet-600 focus-visible:ring-offset-2"
        >
          Create Your First Book
        </a>
        <a
          href="/dashboard"
          className="inline-flex h-12 items-center justify-center rounded-xl border border-border-default px-8 text-base font-semibold text-text-primary transition-all hover:bg-stone-100"
        >
          View My Books
        </a>
      </div>

      {status !== 'authed' && (
        <p className="mt-6 text-sm text-text-muted">
          Already have an account?{' '}
          <a
            href="/login"
            className="font-medium text-violet-600 underline underline-offset-2 hover:text-violet-500"
          >
            Sign In
          </a>
        </p>
      )}
    </>
  );
}
