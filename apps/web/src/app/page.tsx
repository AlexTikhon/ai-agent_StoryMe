'use client';

import { useAuth } from '@/lib/auth/auth-context';
import { getApiBase } from '@/lib/api/config';

function getApiHealthStatus(): { url: string | null; error: string | null } {
  try {
    return { url: `${getApiBase()}/health`, error: null };
  } catch (err) {
    return { url: null, error: err instanceof Error ? err.message : 'API URL is not configured.' };
  }
}

export default function HomePage() {
  const { status } = useAuth();
  const primaryHref = status === 'authed' ? '/dashboard' : '/register';
  const apiHealth = getApiHealthStatus();

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg-base px-4">
      <div className="max-w-container-sm text-center">
        {/* Logo mark */}
        <div className="mx-auto mb-8 flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-brand shadow-brand">
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
            <path
              d="M8 6C8 4.895 8.895 4 10 4H22C23.105 4 24 4.895 24 6V34C24 35.105 23.105 36 22 36H10C8.895 36 8 35.105 8 34V6Z"
              fill="white"
              fillOpacity="0.9"
            />
            <path
              d="M24 8H28C29.105 8 30 8.895 30 10V30C30 31.105 29.105 32 28 32H24V8Z"
              fill="white"
              fillOpacity="0.5"
            />
            <path
              d="M12 12H20M12 16H20M12 20H17"
              stroke="#6535E0"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </div>

        <h1 className="mb-4 font-display text-5xl font-bold text-text-primary">StoryMe</h1>

        <p className="mb-2 text-xl text-text-secondary">Personalized AI Children&apos;s Books</p>

        <p className="mb-10 text-base text-text-muted">
          Create beautifully illustrated stories starring your child — powered by AI.
        </p>

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

        {/* Infrastructure status indicator (dev only) */}
        <div className="mt-16 rounded-xl border border-border-subtle bg-bg-subtle p-4 text-sm text-text-muted">
          <p className="font-semibold text-text-secondary">MVP Demo</p>
          <p className="mt-1">
            <a
              href="/dashboard"
              className="font-medium text-violet-600 underline underline-offset-2 hover:text-violet-500"
            >
              Open Dashboard
            </a>
            {' · '}
            API:{' '}
            {apiHealth.url ? (
              <code className="rounded bg-stone-200 px-1 py-0.5 font-mono text-xs">
                {apiHealth.url}
              </code>
            ) : (
              <span className="font-medium text-red-600">{apiHealth.error}</span>
            )}
          </p>
        </div>
      </div>
    </main>
  );
}
